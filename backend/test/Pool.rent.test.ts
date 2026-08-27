// Suite fonctionnelle TypeScript pour la surface I.4 : le loyer LP.
//
// Ce que cette suite interroge : `notifyRent`, `claimRent` et l'override
// `_update` de Pool.sol, appeles EXACTEMENT comme un composeur les
// appellerait a travers l'ABI generee. L'Auction reelle est testee
// ailleurs (Auction.test.ts, contracts/Auction.t.sol) ; ici on branche
// une EOA comme `auction` via `setAuction`, on lui fait appeler
// `notifyRent`, on fait avancer le temps avec `networkHelpers.time`, et on
// interroge le Pool comme le ferait un integrateur qui ne connait de
// l'enchere que son adresse.
//
// Pourquoi TypeScript/viem plutot que Solidity ici : le parcours du loyer
// est de l'orchestration multi-contrats a travers l'ABI. Un LP approuve
// trois ERC-20 et depose (addLiquidity), l'Auction transfere du MRN au
// Pool puis appelle `notifyRent`, le temps passe, le LP tire son loyer en
// MRN (claimRent, un quatrieme jeton, avec de vrais comptes de part et
// d'autre). Le `_update` d'OZ v5 se teste avec de vrais transferts de
// parts LP entre comptes distincts, ce qu'un test Solidity depuis un
// contrat unique ne reproduit pas. La propriete d'ordre pure de `_update`
// (mint / burn / transfer isole, `vm.warp`) vit dans son jumeau Solidity
// `test/Pool.rent.t.sol`.
//
// DERIVATION DES ATTENDUS. Tous les montants attendus sont derives de la
// formule d'I.4 (build-auction.md 4.4, fiche I.4), jamais d'une sortie
// observee :
//   rentRate      = (amount + rentLeftOver) * 1e18 / EPOCH_DURATION
//   accPerShare  += dt * rentRate / totalSupply()           (echelle 1e18)
//   claimable(x)  = rentPending[x]
//                 + balanceOf(x) * accPerShare / 1e18 - rentDebt[x]
// Sur un mandat entier, le total distribuable vaut donc
// `rentRate * EPOCH_DURATION / 1e18 = amount`, reparti au prorata des
// parts et du temps de detention. La part acquise aux parts mortes de
// 0x...dEaD (MINIMUM_LIQUIDITY) est un residu non reclamable, c'est la
// reponse honnete a "ou va la poussiere" (build-auction.md 4.4).
//
// LE POOL EST FINANCE DE FACON REALISTE. Avant chaque `notifyRent`, on
// transfere au Pool EXACTEMENT le montant notifie, comme le fait
// `Auction.settle()` (70 % du prix de cloture envoyes au Pool, puis
// `pool.notifyRent(lpAmount)`). Sur-financer le Pool masquerait la
// solvabilite, qui est precisement ce que la section V verifie.
//
// Voir test/README.md, section "Etape I.4".

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const EPOCH_DURATION = 14400n; // 4h, cf. build-auction.md 5.0 bis
const PRIORITY_WINDOW = 12n;
const MIN_FEE_NUM = 1n; // cf. PoolTestBase.sol
const NOMINAL_FEE_NUM = 5n;
const MINIMUM_LIQUIDITY = 1000n; // Pool.sol
const SCALE = 10n ** 18n; // l'echelle unique de l'accumulateur

// Amorcage a montants egaux : un depot de SEED par jambe donne des reserves
// [1e10, 1e10, 1e10], un totalSupply de 3e10, et 3e10 - MINIMUM_LIQUIDITY
// parts au deposant (le reste frappe vers 0x...dEaD).
const SEED = 100n * 10n ** 8n; // 1e10

// Loyer de reference. Choisi divisible par EPOCH_DURATION : rentRate tombe
// alors sur 1e36 exactement (1e18 * 1e18), sans troncature a la pose du
// stream, ce qui isole les troncatures ulterieures (celles de l'accumulateur
// et du tirage).
const RENT = EPOCH_DURATION * 10n ** 18n; // 14 400 MRN

// Tolerance des egalites de montant : l'accumulateur tronque a la division
// par totalSupply, le tirage tronque a la division par 1e18. Le manque
// cumule reste tres inferieur au milliardieme de MRN.
const TOL = 10n ** 12n;

// ---------------------------------------------------------------------------
// Fixture et helpers
// ---------------------------------------------------------------------------

async function deployRentFixture() {
  const [deployer, auctionEOA, lp1, lp2, stranger, treasury] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  // MRN : le constructeur mint 100M * 1e18 vers le deployer, qui finance
  // ensuite le Pool a chaque notifyRent.
  const mrn = await viem.deployContract("MRN", []);

  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    EPOCH_DURATION,
    PRIORITY_WINDOW,
    MIN_FEE_NUM,
    NOMINAL_FEE_NUM,
    treasury.account.address,
    mrn.address,
    deployer.account.address,
  ]);

  // Branchement de l'enchere : ici une simple EOA. setAuction est
  // single-shot et onlyOwner (le deployer). Des lors, seule cette EOA peut
  // appeler notifyRent.
  await pool.write.setAuction([auctionEOA.account.address], { account: deployer.account });

  return { deployer, auctionEOA, lp1, lp2, stranger, treasury, wbtc, cbbtc, lbtc, tokens, mrn, pool };
}

type RentFixture = Awaited<ReturnType<typeof deployRentFixture>>;

// Place le prochain bloc exactement sur `timestamp` et le mine. Cible
// absolue plutot que delta relatif : les tranches de stream se comptent a
// la seconde et un `time.increase` deriverait des secondes consommees par
// les transactions precedentes.
async function warpTo(timestamp: bigint) {
  await networkHelpers.time.setNextBlockTimestamp(timestamp);
  await networkHelpers.mine();
}

async function now(): Promise<bigint> {
  return BigInt(await networkHelpers.time.latest());
}

// Un LP depose `amountPerLeg` par jambe, ancre sur le token 0. Sur pool
// vide les trois jambes recoivent le meme montant quel que soit l'ancre.
async function depositAs(
  fixture: RentFixture,
  lp: RentFixture["lp1"],
  amountPerLeg: bigint,
) {
  const { pool, tokens } = fixture;
  for (const token of tokens) {
    await token.write.mint([lp.account.address, amountPerLeg]);
    await token.write.approve([pool.address, amountPerLeg], { account: lp.account });
  }
  await pool.write.addLiquidity([0n, amountPerLeg, 0n], { account: lp.account });
}

// M2 (I.7) : reproduit le pull pattern de `Auction.settle()` ->
// `pool.notifyRent()`. Le deployer finance l'EOA-enchere du montant
// exact (le 70 % qu'un settle reel lui aurait laisse), l'EOA-enchere
// approuve le Pool, et `notifyRent` tire en pull. La section V
// (Solvabilite) repose sur ce financement EXACT : sur-financer le Pool
// masquerait la solvabilite, qui est precisement ce qu'elle verifie.
async function notifyRent(fixture: RentFixture, amount: bigint) {
  const { pool, mrn, deployer, auctionEOA } = fixture;
  await mrn.write.transfer([auctionEOA.account.address, amount], { account: deployer.account });
  await mrn.write.approve([pool.address, amount], { account: auctionEOA.account });
  await pool.write.notifyRent([amount], { account: auctionEOA.account });
}

async function mrnBalance(fixture: RentFixture, address: `0x${string}`): Promise<bigint> {
  return fixture.mrn.read.balanceOf([address]);
}

// Tire le loyer et rend le montant reellement recu en MRN.
async function claimAndMeasure(
  fixture: RentFixture,
  lp: RentFixture["lp1"],
): Promise<bigint> {
  const before = await mrnBalance(fixture, lp.account.address);
  await fixture.pool.write.claimRent({ account: lp.account });
  const after = await mrnBalance(fixture, lp.account.address);
  return after - before;
}

function assertWithinTolBelow(actual: bigint, expected: bigint, label: string) {
  assert.ok(
    actual <= expected && actual >= expected - TOL,
    `${label} : recu ${actual}, attendu ${expected} a ${TOL} pres par en dessous (troncature vers le bas)`,
  );
}

// ---------------------------------------------------------------------------

describe("Pool.rent", async function () {

  // -------------------------------------------------------------------------
  // I] notifyRent — controle d'acces et pose du stream
  // -------------------------------------------------------------------------

  describe("I] notifyRent — controle d'acces et pose du stream", function () {

    describe("A) appelant qui n'est pas l'Auction", function () {
      it("un appel de notifyRent par une adresse quelconque revert NotAuction", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, stranger, deployer } = fixture;
        await depositAs(fixture, fixture.lp1, SEED);

        // Ni un tiers, ni meme l'owner du Pool : setAuction a fige `auction`
        // sur l'EOA-enchere, et notifyRent n'accepte que celle-la.
        await viem.assertions.revertWithCustomError(
          pool.write.notifyRent([RENT], { account: stranger.account }),
          pool,
          "NotAuction",
        );
        await viem.assertions.revertWithCustomError(
          pool.write.notifyRent([RENT], { account: deployer.account }),
          pool,
          "NotAuction",
        );
      });
    });

    describe("B) l'Auction appelle : RentNotified, rentRate et rentEnd derives", function () {
      it("RentNotified porte (amount, rate, end), avec rate et end derives de la formule", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, mrn, deployer, auctionEOA } = fixture;
        await depositAs(fixture, fixture.lp1, SEED);

        // rentLeftOver vaut 0 (premier notifyRent, LP vivant) :
        //   rentRate = amount * 1e18 / EPOCH_DURATION
        //   rentEnd  = block.timestamp + EPOCH_DURATION
        const expectedRate = (RENT * SCALE) / EPOCH_DURATION;

        // M2 (I.7) : l'EOA-enchere detient le MRN, approuve le Pool, et
        // `notifyRent` tire en pull. Le test suivant fixe le timestamp AVANT
        // l'appel pour pouvoir asserter l'event `RentNotified` sur la valeur
        // exacte de `rentEnd` (callTs + EPOCH_DURATION).
        await mrn.write.transfer([auctionEOA.account.address, RENT], { account: deployer.account });
        await mrn.write.approve([pool.address, RENT], { account: auctionEOA.account });
        const callTs = (await now()) + 1n; // le prochain bloc
        await networkHelpers.time.setNextBlockTimestamp(callTs);
        await viem.assertions.emitWithArgs(
          pool.write.notifyRent([RENT], { account: auctionEOA.account }),
          pool,
          "RentNotified",
          [RENT, expectedRate, callTs + EPOCH_DURATION],
        );

        assert.equal(await pool.read.rentRate(), expectedRate, "rentRate");
        assert.equal(await pool.read.rentEnd(), callTs + EPOCH_DURATION, "rentEnd");
        assert.equal(await pool.read.rentLastUpdate(), callTs, "rentLastUpdate pose sur l'instant de l'appel");
      });
    });

    describe("C) E4 — notifyRent alors que totalSupply() <= MINIMUM_LIQUIDITY", function () {

      it("le loyer va dans rentLeftOver, accPerShare inchange, aucun revert", async function () {
        // Aucun addLiquidity : totalSupply() vaut 0, strictement <=
        // MINIMUM_LIQUIDITY. build-auction.md E4 : le loyer ne peut aller a
        // personne (dEaD ne reclame jamais), il s'empile dans rentLeftOver
        // et l'accumulateur ne bouge pas.
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool } = fixture;

        assert.equal(await pool.read.totalSupply(), 0n, "pool non amorce");

        await notifyRent(fixture, RENT);

        assert.equal(await pool.read.rentLeftOver(), RENT, "rentLeftOver a recu tout le montant");
        assert.equal(await pool.read.accPerShare(), 0n, "accPerShare inchange");
        assert.equal(await pool.read.rentRate(), 0n, "rentRate non pose");
        assert.equal(await pool.read.rentEnd(), 0n, "rentEnd non pose");
      });

      it("un notifyRent ulterieur avec des LP vivants replie ce rentLeftOver dans le nouveau rentRate", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool } = fixture;

        // Premier notifyRent sur pool vide : RENT empile en rentLeftOver.
        await notifyRent(fixture, RENT);
        // Un LP arrive.
        await depositAs(fixture, fixture.lp1, SEED);

        // Deuxieme notifyRent, LP vivant : rentLeftOver (RENT) est replie
        //   rentRate = (RENT_2 + rentLeftOver) * 1e18 / EPOCH_DURATION
        const secondAmount = RENT / 2n;
        await notifyRent(fixture, secondAmount);

        const expectedRate = ((secondAmount + RENT) * SCALE) / EPOCH_DURATION;
        assert.equal(await pool.read.rentRate(), expectedRate, "rentRate replie le rentLeftOver");
        assert.equal(await pool.read.rentLeftOver(), 0n, "rentLeftOver remis a zero apres repli");
      });
    });
  });

  // -------------------------------------------------------------------------
  // II] claimRent — le tirage
  // -------------------------------------------------------------------------

  describe("II] claimRent — le tirage", function () {

    describe("A) LP present tout le mandat (test 28)", function () {
      it("claimRent verse ~70 % du prix de cloture moins le poussier des parts mortes", async function () {
        // Derivation : sur un mandat entier, l'accumulateur croit de
        //   accPerShare = EPOCH_DURATION * rentRate / totalSupply
        // et le LP tire
        //   balanceOf(lp) * accPerShare / 1e18
        //   = rentRate * EPOCH_DURATION / 1e18 * partsLP / totalSupply
        //   = RENT * partsLP / totalSupply
        // Le "prix de cloture" est ici RENT (les 70 % deja notifies).
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        await notifyRent(fixture, RENT);
        await warpTo(await pool.read.rentEnd());

        const claimed = await claimAndMeasure(fixture, lp1);

        const expected = (RENT * lp1Shares) / totalSupply;
        assertWithinTolBelow(claimed, expected, "loyer du LP present tout le mandat");

        // La part des parts mortes reste dans le Pool, non reclamable.
        const deadDust = (RENT * MINIMUM_LIQUIDITY) / totalSupply;
        assert.ok(
          expected <= RENT - deadDust + TOL,
          `le LP ne peut pas tirer plus que RENT moins le poussier mort (${deadDust})`,
        );
      });
    });

    describe("B) LP entre a 90 % du mandat (test 29)", function () {
      it("un LP qui rejoint aux 9/10 du mandat ne touche qu'environ 10 % du loyer", async function () {
        // lp1 amorce et tient tout le mandat. lp2 depose un gros montant a
        // t0 + 0,9 * EPOCH_DURATION et tient jusqu'a la fin : il detient la
        // quasi-totalite des parts sur la derniere tranche de 1 440 s.
        // Derivation :
        //   accDelta  = rentRate * (rentEnd - joinTs) / totalSupplyApres
        //   owed(lp2) = lp2Shares * accDelta / 1e18
        //             ~= RENT * 1440 / 14400  (lp2 dominant)  ~= 10 % de RENT
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, lp2 } = fixture;
        await depositAs(fixture, lp1, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        const rentRate = await pool.read.rentRate();
        const joinTs = rentEnd - EPOCH_DURATION / 10n; // 90 % du mandat ecoule

        await warpTo(joinTs - 1n);
        // Gros depot : ~100x l'amorce, lp2 pesera ~99 % des parts.
        await depositAs(fixture, lp2, SEED * 100n);
        const joinedTs = await now();

        const supplyAfter = await pool.read.totalSupply();
        const lp2Shares = await pool.read.balanceOf([lp2.account.address]);

        await warpTo(rentEnd);
        const claimed = await claimAndMeasure(fixture, lp2);

        const tranche2 = rentEnd - joinedTs;
        const accDelta = (rentRate * tranche2) / supplyAfter;
        const expected = (lp2Shares * accDelta) / SCALE;

        assertWithinTolBelow(claimed, expected, "loyer du LP entre a 90 %");
        // Cadrage : bien moins que le loyer d'un mandat entier.
        assert.ok(claimed < RENT / 5n, `un entrant tardif ne touche pas un forfait : ${claimed} vs RENT/5`);
      });
    });

    describe("C) claimRent sans parts et sans rentPending", function () {
      it("revert ZeroRentOwed", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, stranger } = fixture;
        await depositAs(fixture, lp1, SEED);
        await notifyRent(fixture, RENT);
        await warpTo((await pool.read.rentEnd()) - EPOCH_DURATION / 2n);

        // `stranger` n'a jamais detenu de parts : balanceOf == 0,
        // rentPending == 0, l'accru vivant est nul.
        await viem.assertions.revertWithCustomError(
          pool.write.claimRent({ account: stranger.account }),
          pool,
          "ZeroRentOwed",
        );
      });
    });

    describe("D) claim deux fois de suite (test 31)", function () {
      it("le premier claim paie le loyer du mandat, le second revert ZeroRentOwed", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        await notifyRent(fixture, RENT);
        await warpTo(await pool.read.rentEnd());

        const firstClaim = await claimAndMeasure(fixture, lp1);
        assertWithinTolBelow(firstClaim, (RENT * lp1Shares) / totalSupply, "premier claim");

        // Le second n'a plus rien a verser : rentPending remis a zero,
        // rentDebt recale sur l'accru courant, aucun nouveau stream.
        await viem.assertions.revertWithCustomError(
          pool.write.claimRent({ account: lp1.account }),
          pool,
          "ZeroRentOwed",
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // III] _update — la recompense va a qui detenait pendant que ca courait
  // -------------------------------------------------------------------------

  describe("III] _update — la recompense va a qui detenait pendant que ca courait", function () {

    describe("A) LP transfere ses parts en plein stream (test 30)", function () {

      it("etat apres le transfert : le loyer en attente du destinataire est nul", async function () {
        // Le sender a droit au loyer accumule PENDANT qu'il detenait les
        // parts, capture dans rentPending au passage de `_update`. Le
        // destinataire, lui, ne doit RIEN accumuler sur la periode
        // anterieure au transfert : son rentPending doit rester nul et sa
        // dette est recalee sur l'accumulateur courant.
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, lp2 } = fixture;
        await depositAs(fixture, lp1, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        await warpTo(rentEnd - EPOCH_DURATION / 2n); // mi-stream

        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);
        await pool.write.transfer([lp2.account.address, lp1Shares], { account: lp1.account });

        const acc = await pool.read.accPerShare();
        assert.ok(
          (await pool.read.rentPending([lp1.account.address])) > 0n,
          "le sender garde ce qui a couru pendant qu'il detenait les parts",
        );
        assert.equal(
          await pool.read.rentPending([lp2.account.address]),
          0n,
          "le destinataire n'accumule rien sur la periode d'avant le transfert",
        );
        assert.equal(
          await pool.read.rentDebt([lp2.account.address]),
          (lp1Shares * acc) / SCALE,
          "la dette du destinataire est recalee sur l'accumulateur courant",
        );
      });

      it("payouts : le sender garde sa tranche, le destinataire n'a que la tranche posterieure", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, lp2 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        const mid = rentEnd - EPOCH_DURATION / 2n;

        await warpTo(mid);
        await pool.write.transfer([lp2.account.address, lp1Shares], { account: lp1.account });
        const transferTs = await now();
        await warpTo(rentEnd);

        const lp1Claimed = await claimAndMeasure(fixture, lp1);
        const lp2Claimed = await claimAndMeasure(fixture, lp2);

        // Chacun ~= la moitie du loyer du mandat sur les parts concernees.
        const heldBefore = transferTs - (rentEnd - EPOCH_DURATION); // secondes detenues par lp1
        const expectedLp1 = (RENT * heldBefore / EPOCH_DURATION) * lp1Shares / totalSupply;
        const expectedLp2 = (RENT * (rentEnd - transferTs) / EPOCH_DURATION) * lp1Shares / totalSupply;

        assertWithinTolBelow(lp1Claimed, expectedLp1, "loyer du sender (periode detenue)");
        assertWithinTolBelow(lp2Claimed, expectedLp2, "loyer du destinataire (periode posterieure seulement)");
      });
    });

    describe("B) LP brule toutes ses parts en plein stream puis claimRent (E5)", function () {

      it("apres removeLiquidity : balanceOf nul, rentPending = l'accru de la periode detenue", async function () {
        // build-auction.md E5 : dans OZ v5, `_update` tourne AVANT le
        // deplacement du solde pour la capture du sender. Un LP qui brule
        // tout au milieu du stream doit voir son accru fige dans
        // rentPending, exactement egal a balanceOf_pre * accPerShare / 1e18
        // (sa dette valait zero).
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        await warpTo(rentEnd - EPOCH_DURATION / 2n);

        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);
        await pool.write.removeLiquidity([lp1Shares, [0n, 0n, 0n]], { account: lp1.account });

        assert.equal(await pool.read.balanceOf([lp1.account.address]), 0n, "toutes les parts brulees");
        const acc = await pool.read.accPerShare();
        assert.equal(
          await pool.read.rentPending([lp1.account.address]),
          (lp1Shares * acc) / SCALE,
          "rentPending fige = accru de la periode detenue",
        );
      });

      it("claimRent verse cet accru, ne vole ni ne perd un reglement", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        const exitTs = rentEnd - EPOCH_DURATION / 2n;

        await warpTo(exitTs);
        await pool.write.removeLiquidity([lp1Shares, [0n, 0n, 0n]], { account: lp1.account });
        const removedTs = await now();
        await warpTo(rentEnd);

        const claimed = await claimAndMeasure(fixture, lp1);

        // Il touche ce qui a couru pendant [t0, sortie], rien de plus.
        const held = removedTs - (rentEnd - EPOCH_DURATION);
        const expected = (RENT * held / EPOCH_DURATION) * lp1Shares / totalSupply;
        assertWithinTolBelow(claimed, expected, "loyer d'un LP sorti en plein stream");
      });
    });

    describe("C) mint : un LP arrive apres un notifyRent n'a aucune creance sur la rent d'avant son arrivee", function () {

      it("join en plein stream : le rentPending du nouveau LP est nul", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, lp2 } = fixture;
        await depositAs(fixture, lp1, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        await warpTo(rentEnd - EPOCH_DURATION / 2n); // la moitie du stream a deja coule

        await depositAs(fixture, lp2, SEED);

        assert.equal(
          await pool.read.rentPending([lp2.account.address]),
          0n,
          "un LP qui arrive a mi-stream n'a aucune creance sur la premiere moitie",
        );
        const acc = await pool.read.accPerShare();
        const lp2Shares = await pool.read.balanceOf([lp2.account.address]);
        assert.equal(
          await pool.read.rentDebt([lp2.account.address]),
          (lp2Shares * acc) / SCALE,
          "sa dette part de l'accumulateur courant",
        );
      });

      it("join apres la fin du stream : le rentPending du nouveau LP est nul", async function () {
        // Cas le plus net : lp2 depose APRES que le stream entier a coule.
        // Aucune part du loyer ne peut lui revenir, quel que soit le
        // montant de l'accumulateur a cet instant.
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, lp2 } = fixture;
        await depositAs(fixture, lp1, SEED);

        await notifyRent(fixture, RENT);
        await warpTo((await pool.read.rentEnd()) + 100n); // stream termine

        await depositAs(fixture, lp2, SEED);

        assert.equal(
          await pool.read.rentPending([lp2.account.address]),
          0n,
          "un LP arrive apres la fin du stream n'a aucune creance",
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // IV] Timing du reglement — rien n'est bloque (test 32, VERSION FICHE)
  //
  // La fiche I.4 renvoie l'ancrage sur la tenure en roadmap : le seul
  // requis ici est "rien n'est bloque dans aucun des trois moments", PAS
  // que la distribution se fasse "sur la moitie restante".
  // -------------------------------------------------------------------------

  describe("IV] Timing du reglement — rien n'est bloque (test 32, version fiche)", function () {

    describe("A) notifyRent pendant le silence (avant le debut du mandat)", function () {
      it("tout se distribue, rien n'echoue", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        await notifyRent(fixture, RENT);
        await warpTo(await pool.read.rentEnd());

        const claimed = await claimAndMeasure(fixture, lp1);
        assertWithinTolBelow(claimed, (RENT * lp1Shares) / totalSupply, "loyer distribue");

        // Rien d'echoue et rien d'immobilise au-dela du poussier mort.
        const stranded = await mrnBalance(fixture, pool.address);
        assert.ok(
          stranded <= (RENT * MINIMUM_LIQUIDITY) / totalSupply + TOL,
          `residu MRN du Pool ${stranded} : au plus le poussier des parts mortes`,
        );
      });
    });

    describe("B) notifyRent a mi-mandat", function () {
      it("tout se distribue, rien n'echoue (sans exiger la distribution sur la moitie restante)", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        // notifyRent "a mi-mandat" : ici, simplement, on laisse le stream
        // courir tout son EPOCH_DURATION puis on tire. Le seul requis est
        // qu'a la fin, le loyer soit integralement distribuable.
        await notifyRent(fixture, RENT);
        await warpTo((await pool.read.rentEnd()) + EPOCH_DURATION); // large marge

        const claimed = await claimAndMeasure(fixture, lp1);
        assertWithinTolBelow(claimed, (RENT * lp1Shares) / totalSupply, "loyer integralement distribuable");
      });
    });

    describe("C) deux notifyRent rapproches", function () {

      it("la traine non distribuee du premier est repliee dans rentLeftOver et se retrouve dans le second stream", async function () {
        // Pur controle d'etat, independant du tirage : au deuxieme
        // notifyRent, la traine du premier stream
        //   rentRate_1 * (rentEnd_1 - now) / 1e18
        // est repliee dans rentLeftOver, puis
        //   rentRate_2 = (amount_2 + rentLeftOver) * 1e18 / EPOCH_DURATION.
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool } = fixture;
        await depositAs(fixture, fixture.lp1, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd1 = await pool.read.rentEnd();
        const rentRate1 = await pool.read.rentRate();

        // On avance d'un quart de mandat puis on re-notifie.
        const secondTs = rentEnd1 - (EPOCH_DURATION * 3n) / 4n;
        await warpTo(secondTs - 1n);

        const secondAmount = RENT / 3n;
        await notifyRent(fixture, secondAmount);
        const notifiedTs = await now();

        const foldedTrail = (rentRate1 * (rentEnd1 - notifiedTs)) / SCALE;
        const expectedRate2 = ((secondAmount + foldedTrail) * SCALE) / EPOCH_DURATION;

        assert.equal(await pool.read.rentRate(), expectedRate2, "la traine du premier stream est repliee dans rentRate");
        assert.equal(await pool.read.rentLeftOver(), 0n, "rentLeftOver remis a zero apres repli");
        assert.equal(await pool.read.rentEnd(), notifiedTs + EPOCH_DURATION, "nouvel horizon de stream");
      });

      it("aucun MRN perdu : le total reclamable finit egal a la somme notifiee moins le poussier mort", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        const totalSupply = await pool.read.totalSupply();
        const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

        await notifyRent(fixture, RENT);
        await warpTo((await pool.read.rentEnd()) - (EPOCH_DURATION * 3n) / 4n);
        const secondAmount = RENT / 3n;
        await notifyRent(fixture, secondAmount);
        await warpTo(await pool.read.rentEnd());

        const claimed = await claimAndMeasure(fixture, lp1);

        const totalNotified = RENT + secondAmount;
        const expected = (totalNotified * lp1Shares) / totalSupply;
        assertWithinTolBelow(claimed, expected, "total distribue sur les deux streams");
      });
    });
  });

  // -------------------------------------------------------------------------
  // V] Solvabilite (corollaire I.4 de l'invariant I5 de build-auction.md 7.2)
  // -------------------------------------------------------------------------

  describe("V] Solvabilite (corollaire I.4 de l'invariant I5)", function () {

    describe("A) une epoch de touches frequentes et plusieurs claims", function () {
      it("somme des montants reclames <= amount notifie, et aucun claimRent ne revert pour solde insuffisant", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1, lp2 } = fixture;
        await depositAs(fixture, lp1, SEED);
        await depositAs(fixture, lp2, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();
        const start = rentEnd - EPOCH_DURATION;

        let totalClaimed = 0n;
        // Six touches reparties sur le mandat : lp1 et lp2 tirent en
        // alternance, avec des transferts de parts entre eux.
        for (let k = 1n; k <= 5n; k++) {
          await warpTo(start + (EPOCH_DURATION * k) / 6n);
          const claimer = k % 2n === 0n ? lp1 : lp2;
          try {
            totalClaimed += await claimAndMeasure(fixture, claimer);
          } catch (error) {
            // Un claim qui n'a rien a verser revert ZeroRentOwed : c'est
            // legitime, on l'ignore. Tout autre revert (solde MRN
            // insuffisant) fait echouer le test.
            if (!String(error).includes("ZeroRentOwed")) throw error;
          }
        }
        await warpTo(rentEnd + 10n);
        totalClaimed += await claimAndMeasure(fixture, lp1);
        totalClaimed += await claimAndMeasure(fixture, lp2);

        assert.ok(
          totalClaimed <= RENT,
          `somme reclamee ${totalClaimed} doit rester <= amount notifie ${RENT} (invariant I5)`,
        );
      });
    });

    describe("B) le poussier reste dans le Pool, jamais un deficit", function () {
      it("le solde MRN du Pool couvre toujours toute creance restante", async function () {
        const fixture = await networkHelpers.loadFixture(deployRentFixture);
        const { pool, lp1 } = fixture;
        await depositAs(fixture, lp1, SEED);

        await notifyRent(fixture, RENT);
        const rentEnd = await pool.read.rentEnd();

        // A plusieurs instants du stream, le solde MRN du Pool ne descend
        // jamais sous ce que le seul LP pourrait encore reclamer.
        for (let k = 1n; k <= 4n; k++) {
          await warpTo(rentEnd - EPOCH_DURATION + (EPOCH_DURATION * k) / 4n);
          const acc = await pool.read.accPerShare();
          const bal = await pool.read.balanceOf([lp1.account.address]);
          const claimable =
            (await pool.read.rentPending([lp1.account.address])) +
            ((bal * acc) / SCALE - (await pool.read.rentDebt([lp1.account.address])));
          const poolMrn = await mrnBalance(fixture, pool.address);
          assert.ok(
            poolMrn >= claimable,
            `a la tranche ${k}/4 : solde MRN du Pool ${poolMrn} < creance reclamable ${claimable}`,
          );
        }
      });
    });
  });

  // -------------------------------------------------------------------------
  // GREEN de la fiche I.4
  // -------------------------------------------------------------------------

  describe("GREEN de la fiche", function () {

    it("une adresse qui achete des parts un bloc avant le reglement touche une part proportionnelle au temps de detention", async function () {
      // L'anti-front-run de build-auction.md 4.4 (2) : un acheteur de
      // derniere minute ne touche PAS un forfait, seulement une lamelle
      // proportionnelle aux quelques secondes detenues.
      const fixture = await networkHelpers.loadFixture(deployRentFixture);
      const { pool, lp1, lp2 } = fixture;
      await depositAs(fixture, lp1, SEED);

      await notifyRent(fixture, RENT);
      const rentEnd = await pool.read.rentEnd();
      const rentRate = await pool.read.rentRate();

      await warpTo(rentEnd - 61n);
      await depositAs(fixture, lp2, SEED); // achat ~1 minute avant la fin
      const joinTs = await now();

      const supplyAfter = await pool.read.totalSupply();
      const lp2Shares = await pool.read.balanceOf([lp2.account.address]);

      await warpTo(rentEnd);
      const claimed = await claimAndMeasure(fixture, lp2);

      const held = rentEnd - joinTs; // ~60 s
      const expected = (lp2Shares * ((rentRate * held) / supplyAfter)) / SCALE;
      assertWithinTolBelow(claimed, expected, "lamelle proportionnelle de l'acheteur tardif");
      assert.ok(
        claimed < RENT / 50n,
        `l'acheteur tardif ne touche pas un forfait : ${claimed} vs RENT/50 (${RENT / 50n})`,
      );
    });

    it("une adresse qui a tenu tout le mandat puis sort avant de reclamer garde tout ce qu'elle a accumule", async function () {
      const fixture = await networkHelpers.loadFixture(deployRentFixture);
      const { pool, lp1, lp2 } = fixture;
      await depositAs(fixture, lp1, SEED);

      const totalSupply = await pool.read.totalSupply();
      const lp1Shares = await pool.read.balanceOf([lp1.account.address]);

      await notifyRent(fixture, RENT);
      await warpTo(await pool.read.rentEnd());

      // lp1 sort de sa position (transfere toutes ses parts) APRES la fin
      // du stream, AVANT de reclamer : `_update` fige son accru dans
      // rentPending, et claimRent doit encore le verser en entier.
      await pool.write.transfer([lp2.account.address, lp1Shares], { account: lp1.account });
      const claimed = await claimAndMeasure(fixture, lp1);

      assertWithinTolBelow(claimed, (RENT * lp1Shares) / totalSupply, "loyer preserve apres sortie de position");
    });
  });
});
