// Suite fonctionnelle TypeScript pour Pool.addLiquidity().
//
// Pourquoi TypeScript/viem plutot que Solidity ici : ces tests appellent le
// contrat exactement comme le fait le front, a travers l'ABI generee, et
// orchestrent trois ERC-20 (mint + approve) avant chaque depot. C'est de
// l'integration multi-contrats, le terrain naturel de la couche TS. La
// couche Solidity (fuzz + invariants) est une question distincte, laissee a
// l'auteur (voir test/README.md, section "A venir").
//
// Voir test/README.md pour la demarche complete et la liste des cas limites
// groupee par fonction.

import { network } from "hardhat";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { viem, networkHelpers } = await network.create();

// ---------------------------------------------------------------------------
// Constantes du contrat (dupliquees ici en dur : Pool.sol est fige pour cette
// tache, on ne lit pas ces valeurs depuis le contrat).
// ---------------------------------------------------------------------------

const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD" as const;
const MINIMUM_LIQUIDITY = 1000n;
const UINT72_MAX = 2n ** 72n - 1n;
const DEFAULT_FEE_NUM = 5n; // reprend la valeur du Pool.t.sol d'origine

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function deployTokensAndPoolFixture() {
  const [deployer, depositor, other] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    DEFAULT_FEE_NUM,
    deployer.account.address,
  ]);

  return { deployer, depositor, other, wbtc, cbbtc, lbtc, tokens, pool };
}

type PoolFixture = Awaited<ReturnType<typeof deployTokensAndPoolFixture>>;

// Mint `amount` des 3 tokens vers `account` et approuve le pool pour ce meme
// montant sur chacun. Facteur commun a toutes les fixtures : chaque depot
// exige un approve prealable sur les 3 ERC-20.
async function mintAndApprove(
  tokens: PoolFixture["tokens"],
  pool: PoolFixture["pool"],
  account: PoolFixture["depositor"],
  amount: bigint,
) {
  for (const token of tokens) {
    await token.write.mint([account.account.address, amount]);
    await token.write.approve([pool.address, amount], { account: account.account });
  }
}

async function readReserves(pool: PoolFixture["pool"]): Promise<[bigint, bigint, bigint]> {
  return [
    await pool.read.reserves([0n]),
    await pool.read.reserves([1n]),
    await pool.read.reserves([2n]),
  ];
}

async function readBalances(
  tokens: PoolFixture["tokens"],
  address: `0x${string}`,
): Promise<[bigint, bigint, bigint]> {
  return [
    await tokens[0].read.balanceOf([address]),
    await tokens[1].read.balanceOf([address]),
    await tokens[2].read.balanceOf([address]),
  ];
}

// Rejette avec le panic Solidity `panicCodeHex` (ex. "0x11"), et seulement
// celui-la : on verifie le message d'erreur plutot qu'une simple absence de
// succes, pour ne pas confondre un panic avec une erreur nommee.
async function assertPanic(promise: Promise<unknown>, panicCodeHex: string) {
  await assert.rejects(promise, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, new RegExp(panicCodeHex));
    return true;
  });
}

const SEED_AMOUNT = 100n * 10n ** 8n; // pool amorce a 100 (8 decimales) sur chaque reserve

async function deploySeededPoolFixture() {
  const base = await deployTokensAndPoolFixture();
  const { depositor, tokens, pool } = base;

  // Marge genereuse pour les depots/echanges additionnels effectues dans les
  // tests qui reutilisent cette fixture.
  const headroom = SEED_AMOUNT * 10n;
  await mintAndApprove(tokens, pool, depositor, headroom);

  await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

  return { ...base, seedAmount: SEED_AMOUNT };
}

// Fixture dediee au pool desequilibre (section II.D). feeNum = 0 ici, par
// choix delibere : avec des frais non nuls, le swap ci-dessous produirait des
// reserves qui ne se divisent pas proprement, et les depots "10% du pool"
// utilises dans toute la section D laisseraient un reste d'arrondi qui
// polluerait les assertions de ratio/proportionnalite. Le comportement des
// frais est deja couvert par les tests de swap (hors perimetre de ce
// fichier) ; cette fixture isole la seule arithmetique d'addLiquidity.
async function deployImbalancedPoolFixture() {
  const [deployer, depositor, other] = await viem.getWalletClients();

  const wbtc = await viem.deployContract("MockWrappedBTC", ["Wrapped BTC", "wBTC"]);
  const cbbtc = await viem.deployContract("MockWrappedBTC", ["Coinbase BTC", "cbBTC"]);
  const lbtc = await viem.deployContract("MockWrappedBTC", ["Lombard BTC", "lBTC"]);
  const tokens = [wbtc, cbbtc, lbtc] as const;

  const pool = await viem.deployContract("Pool", [
    [wbtc.address, cbbtc.address, lbtc.address],
    0n,
    deployer.account.address,
  ]);

  const seedAmount = 1000n * 10n ** 8n; // reserves de depart : [1000e8, 1000e8, 1000e8]
  await mintAndApprove(tokens, pool, depositor, seedAmount * 10n);
  await pool.write.addLiquidity([0n, seedAmount, 0n], { account: depositor.account });

  // Swap de 250e8 de token0 vers token2, feeNum = 0 :
  //   amountOut = amountIn * reserveOut / (amountIn + reserveIn)
  //             = 250e8 * 1000e8 / (250e8 + 1000e8)
  //             = 250e8 * 1000e8 / 1250e8
  //             = 200e8
  // Reserves apres le swap : [1250e8, 1000e8, 800e8]
  // totalSupply apres l'amorcage : 3 * 1000e8 = 300 000 000 000 (part brulee
  // vers l'adresse morte incluse)
  const swapAmount = 250n * 10n ** 8n;
  await pool.write.swap([0n, swapAmount, 2n, 0n], { account: depositor.account });

  return { deployer, depositor, other, wbtc, cbbtc, lbtc, tokens, pool, seedAmount };
}

// ---------------------------------------------------------------------------
// Plan de la suite (squelette). Reflete la structure reelle ci-dessous.
// ---------------------------------------------------------------------------

describe("Pool.addLiquidity", async function () {
  describe("Plan de test", function () {
    describe("I] addLiquidity sur pool vide", function () {
      describe("A) Cas nominal", function () {
        it.todo("mintedShares vaut 3 * _amount - MINIMUM_LIQUIDITY");
        it.todo("les trois reserves valent _amount");
        it.todo("MINIMUM_LIQUIDITY est detenu par l'adresse morte");
        it.todo("totalSupply() inclut les parts brulees vers l'adresse morte");
        it.todo("le solde du pool en chacun des trois tokens augmente de _amount");
        it.todo("le solde du deposant en chacun des trois tokens diminue de _amount");
        it.todo("l'evenement AddedLiquidity est emis avec les bons arguments");
      });
      describe("B) Reverts", function () {
        it.todo("3 * _amount < MINIMUM_LIQUIDITY echoue par panic 0x11, pas par une erreur nommee");
        it.todo("_amount > type(uint72).max echoue avec ReserveOverflow");
        it.todo("_minShares > mintedShares echoue avec BadSlippage");
        it.todo("amount trop grand ET minShares trop exigeant : BadSlippage avant ReserveOverflow");
      });
      describe("C) Cas limites", function () {
        it.todo("_minShares exactement egal aux parts mintees est accepte");
        it.todo("_anchorIndex hors bornes (99) sur un pool vide reussit sans revert");
      });
    });

    describe("II] addLiquidity sur pool amorce", function () {
      describe("A) Cas nominal", function () {
        it.todo("mintedShares vaut supply * _amount / reserves[anchor]");
        it.todo("chaque reserve croit de _amount * reserves[i] / reserves[anchor]");
        it.todo("sur un pool equilibre, le resultat est identique quel que soit _anchorIndex");
        it.todo("un second deposant obtient des parts proportionnelles au premier");
      });
      describe("B) Reverts", function () {
        it.todo("une approbation insuffisante sur un seul des trois tokens revert (ERC-20)");
      });
      describe("C) Cas limites", function () {
        it.todo("_amount == 0 ne mint aucune part, aucun revert");
        it.todo("_anchorIndex hors bornes (99) sur un pool amorce echoue par panic 0x32");
      });
      describe("D) Pool desequilibre", function () {
        describe("1) Composition et parts, independamment de la formule interne", function () {
          it.todo("un depot ne modifie la composition du pool pour aucun choix d'ancre");
          it.todo("ancre sur l'actif abondant, un apport de 10% du pool mint 10% du totalSupply precedent");
          it.todo("ancre sur l'actif rare, un apport de 10% du pool mint 10% du totalSupply precedent");
        });
        describe("2) Consequence observable du choix de l'ancre (calcul a la main)", function () {
          it.todo("a _amount identique, ancrer sur l'actif abondant mint 24 000 000 000 parts");
          it.todo("a _amount identique, ancrer sur l'actif rare mint 37 500 000 000 parts");
          it.todo("a _amount identique, l'ancre rare preleve plus sur le troisieme token que l'ancre abondante");
        });
      });
    });
  });

  // ---------------------------------------------------------------------------
  // I] addLiquidity sur pool vide
  // ---------------------------------------------------------------------------

  describe("I] addLiquidity sur pool vide", function () {
    describe("A) Cas nominal", function () {
      it("mintedShares vaut 3 * _amount - MINIMUM_LIQUIDITY", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const mintedShares = await pool.read.balanceOf([depositor.account.address]);
        assert.equal(mintedShares, 3n * SEED_AMOUNT - MINIMUM_LIQUIDITY);
      });

      it("les trois reserves valent _amount", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const reserves = await readReserves(pool);
        assert.deepEqual(reserves, [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT]);
      });

      it("MINIMUM_LIQUIDITY est detenu par l'adresse morte", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const deadBalance = await pool.read.balanceOf([DEAD_ADDRESS]);
        assert.equal(deadBalance, MINIMUM_LIQUIDITY);
      });

      it("totalSupply() inclut les parts brulees vers l'adresse morte", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const totalSupply = await pool.read.totalSupply();
        assert.equal(totalSupply, 3n * SEED_AMOUNT);
      });

      it("le solde du pool en chacun des trois tokens augmente de _amount", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const poolBalances = await readBalances(tokens, pool.address);
        assert.deepEqual(poolBalances, [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT]);
      });

      it("le solde du deposant en chacun des trois tokens diminue de _amount", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);
        const balancesBefore = await readBalances(tokens, depositor.account.address);

        await pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account });

        const balancesAfter = await readBalances(tokens, depositor.account.address);
        const spent = balancesBefore.map((before, i) => before - balancesAfter[i]);
        assert.deepEqual(spent, [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT]);
      });

      it("l'evenement AddedLiquidity est emis avec les bons arguments", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await viem.assertions.emitWithArgs(
          pool.write.addLiquidity([0n, SEED_AMOUNT, 0n], { account: depositor.account }),
          pool,
          "AddedLiquidity",
          [
            depositor.account.address,
            [SEED_AMOUNT, SEED_AMOUNT, SEED_AMOUNT],
            3n * SEED_AMOUNT - MINIMUM_LIQUIDITY,
          ],
        );
      });
    });

    describe("B) Reverts", function () {
      it("3 * _amount < MINIMUM_LIQUIDITY echoue par panic 0x11, pas par une erreur nommee", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        // 3 * 100 = 300 < MINIMUM_LIQUIDITY (1000) : la soustraction sous-flow
        // avant meme d'atteindre le require de BadSlippage.
        const tooSmallAmount = 100n;

        await assertPanic(
          pool.write.addLiquidity([0n, tooSmallAmount, 0n], { account: depositor.account }),
          "0x11",
        );
      });

      it("_amount > type(uint72).max echoue avec ReserveOverflow", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const tooLargeAmount = UINT72_MAX + 1n;

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, tooLargeAmount, 0n], { account: depositor.account }),
          pool,
          "ReserveOverflow",
        );
      });

      it("_minShares > mintedShares echoue avec BadSlippage", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);
        const mintedShares = 3n * SEED_AMOUNT - MINIMUM_LIQUIDITY;

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, SEED_AMOUNT, mintedShares + 1n], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });

      it("amount trop grand ET minShares trop exigeant : BadSlippage avant ReserveOverflow", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        const tooLargeAmount = UINT72_MAX + 1n;
        // mintedShares theorique = 3 * tooLargeAmount - MINIMUM_LIQUIDITY (le
        // require de slippage est evalue avant celui d'overflow, Pool.sol:76-77)
        const mintedShares = 3n * tooLargeAmount - MINIMUM_LIQUIDITY;

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, tooLargeAmount, mintedShares + 1n], { account: depositor.account }),
          pool,
          "BadSlippage",
        );
      });
    });

    describe("C) Cas limites", function () {
      it("_minShares exactement egal aux parts mintees est accepte", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);
        const mintedShares = 3n * SEED_AMOUNT - MINIMUM_LIQUIDITY;

        // Ne doit pas revert : on attend juste que la promesse se resolve.
        await assert.doesNotReject(
          pool.write.addLiquidity([0n, SEED_AMOUNT, mintedShares], { account: depositor.account }),
        );
      });

      it("_anchorIndex hors bornes (99) sur un pool vide reussit sans revert", async function () {
        // Documente un comportement du contrat : sur la branche supply == 0,
        // _anchorIndex n'est jamais lu (Pool.sol:74-81), donc une valeur hors
        // bornes n'a aucun effet.
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deployTokensAndPoolFixture);
        await mintAndApprove(tokens, pool, depositor, SEED_AMOUNT);

        await assert.doesNotReject(
          pool.write.addLiquidity([99n, SEED_AMOUNT, 0n], { account: depositor.account }),
        );
      });
    });
  });

  // ---------------------------------------------------------------------------
  // II] addLiquidity sur pool amorce
  // ---------------------------------------------------------------------------

  describe("II] addLiquidity sur pool amorce", function () {
    const ADD_AMOUNT = SEED_AMOUNT / 2n; // 50e8 : depot additionnel distinct du depot initial

    describe("A) Cas nominal", function () {
      it("mintedShares vaut supply * _amount / reserves[anchor]", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const supplyBefore = await pool.read.totalSupply();
        const reservesBefore = await readReserves(pool);

        await pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: depositor.account });

        const mintedShares = await pool.read.balanceOf([depositor.account.address]);
        const expectedTotalShares =
          (3n * SEED_AMOUNT - MINIMUM_LIQUIDITY) + (supplyBefore * ADD_AMOUNT) / reservesBefore[0];
        assert.equal(mintedShares, expectedTotalShares);
      });

      it("chaque reserve croit de _amount * reserves[i] / reserves[anchor]", async function () {
        const { pool, tokens, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const reservesBefore = await readReserves(pool);

        await pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: depositor.account });

        const reservesAfter = await readReserves(pool);
        const growth = reservesAfter.map((after, i) => after - reservesBefore[i]) as [bigint, bigint, bigint];
        const expectedGrowth = reservesBefore.map(
          (r) => (ADD_AMOUNT * r) / reservesBefore[0],
        ) as [bigint, bigint, bigint];
        assert.deepEqual(growth, expectedGrowth);
      });

      it("sur un pool equilibre, le resultat est identique quel que soit _anchorIndex", async function () {
        const mintedSharesByAnchor: bigint[] = [];

        for (const anchor of [0n, 1n, 2n]) {
          const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
          await pool.write.addLiquidity([anchor, ADD_AMOUNT, 0n], { account: depositor.account });
          const mintedTotal = await pool.read.balanceOf([depositor.account.address]);
          mintedSharesByAnchor.push(mintedTotal);
        }

        assert.equal(new Set(mintedSharesByAnchor).size, 1);
      });

      it("un second deposant obtient des parts proportionnelles au premier", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const supplyBefore = await pool.read.totalSupply();
        const reservesBefore = await readReserves(pool);
        await mintAndApprove(tokens, pool, other, ADD_AMOUNT);

        await pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: other.account });

        const otherShares = await pool.read.balanceOf([other.account.address]);
        const expectedShares = (supplyBefore * ADD_AMOUNT) / reservesBefore[0];
        assert.equal(otherShares, expectedShares);
      });
    });

    describe("B) Reverts", function () {
      it("une approbation insuffisante sur un seul des trois tokens revert (ERC-20)", async function () {
        const { pool, tokens, other } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        // Les deux premiers tokens sont pleinement approuves, le troisieme
        // (lbtc, index 2) ne l'est pas du tout : le transferFrom sur lbtc doit
        // revert avant la fin de la boucle (Pool.sol:96-98).
        await tokens[0].write.mint([other.account.address, ADD_AMOUNT]);
        await tokens[0].write.approve([pool.address, ADD_AMOUNT], { account: other.account });
        await tokens[1].write.mint([other.account.address, ADD_AMOUNT]);
        await tokens[1].write.approve([pool.address, ADD_AMOUNT], { account: other.account });
        await tokens[2].write.mint([other.account.address, ADD_AMOUNT]);
        // pas d'approve sur tokens[2]

        await viem.assertions.revertWithCustomError(
          pool.write.addLiquidity([0n, ADD_AMOUNT, 0n], { account: other.account }),
          tokens[2],
          "ERC20InsufficientAllowance",
        );
      });
    });

    describe("C) Cas limites", function () {
      it("_amount == 0 ne mint aucune part, aucun revert", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        const supplyBefore = await pool.read.totalSupply();

        await assert.doesNotReject(
          pool.write.addLiquidity([0n, 0n, 0n], { account: depositor.account }),
        );

        const supplyAfter = await pool.read.totalSupply();
        assert.equal(supplyAfter, supplyBefore);
      });

      it("_anchorIndex hors bornes (99) sur un pool amorce echoue par panic 0x32", async function () {
        const { pool, depositor } = await networkHelpers.loadFixture(deploySeededPoolFixture);
        // Sur la branche supply != 0, cachedReserves[_anchorIndex] est lu des
        // la ligne 86 : un index hors bornes d'un tableau memoire declenche un
        // acces hors bornes (Pool.sol:84-86).

        await assertPanic(
          pool.write.addLiquidity([99n, SEED_AMOUNT, 0n], { account: depositor.account }),
          "0x32",
        );
      });
    });

    describe("D) Pool desequilibre", function () {
      describe("1) Composition et parts, independamment de la formule interne", function () {
        it("un depot ne modifie la composition du pool pour aucun choix d'ancre", async function () {
          // Propriete d'AMM : apres un depot proportionnel, le rapport entre
          // deux reserves quelconques doit rester ce qu'il etait avant. On ne
          // recalcule pas la formule du contrat (Pool.sol:90) : on verifie
          // l'egalite croisee reservesApres[i] * reservesAvant[j] ==
          // reservesApres[j] * reservesAvant[i], qui ne depend que de ce que
          // doit etre un AMM.
          const ratiosPreserved: boolean[] = [];

          for (const anchor of [0n, 1n, 2n]) {
            const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
            const reservesBefore = await readReserves(pool);
            const depositAmount = reservesBefore[Number(anchor)] / 10n; // 10% de la reserve ancre

            await mintAndApprove(tokens, pool, other, depositAmount * 2n);
            await pool.write.addLiquidity([anchor, depositAmount, 0n], { account: other.account });

            const reservesAfter = await readReserves(pool);
            const pairs: [number, number][] = [[0, 1], [1, 2], [0, 2]];
            const preserved = pairs.every(
              ([i, j]) => reservesAfter[i] * reservesBefore[j] === reservesAfter[j] * reservesBefore[i],
            );
            ratiosPreserved.push(preserved);
          }

          assert.deepEqual(ratiosPreserved, [true, true, true]);
        });

        it("ancre sur l'actif abondant, un apport de 10% du pool mint 10% du totalSupply precedent", async function () {
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const reservesBefore = await readReserves(pool);
          const depositAmount = reservesBefore[0] / 10n; // token0 = actif abondant (1250e8)

          await mintAndApprove(tokens, pool, other, depositAmount * 2n);
          await pool.write.addLiquidity([0n, depositAmount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          assert.equal(mintedShares, supplyBefore / 10n);
        });

        it("ancre sur l'actif rare, un apport de 10% du pool mint 10% du totalSupply precedent", async function () {
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const supplyBefore = await pool.read.totalSupply();
          const reservesBefore = await readReserves(pool);
          const depositAmount = reservesBefore[2] / 10n; // token2 = actif rare (800e8)

          await mintAndApprove(tokens, pool, other, depositAmount * 2n);
          await pool.write.addLiquidity([2n, depositAmount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          assert.equal(mintedShares, supplyBefore / 10n);
        });
      });

      describe("2) Consequence observable du choix de l'ancre (calcul a la main)", function () {
        it("a _amount identique, ancrer sur l'actif abondant mint 24 000 000 000 parts", async function () {
          // supply avant depot = 300 000 000 000 (cf. fixture)
          // reserves avant depot = [1250e8, 1000e8, 800e8] (cf. fixture)
          // mintedShares = supply * amount / reserves[0]
          //              = 300 000 000 000 * 10 000 000 000 / 125 000 000 000
          //              = 300 000 000 000 * 0,08
          //              = 24 000 000 000
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const amount = 100n * 10n ** 8n;
          await mintAndApprove(tokens, pool, other, amount);

          await pool.write.addLiquidity([0n, amount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          assert.equal(mintedShares, 24_000_000_000n);
        });

        it("a _amount identique, ancrer sur l'actif rare mint 37 500 000 000 parts", async function () {
          // supply avant depot = 300 000 000 000 (cf. fixture)
          // reserves avant depot = [1250e8, 1000e8, 800e8] (cf. fixture)
          // mintedShares = supply * amount / reserves[2]
          //              = 300 000 000 000 * 10 000 000 000 / 80 000 000 000
          //              = 300 000 000 000 * 0,125
          //              = 37 500 000 000
          const { pool, tokens, other } = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          const amount = 100n * 10n ** 8n;
          // Ancrer sur le token rare (index 2) preleve plus que `amount` sur
          // les deux autres tokens (voir le calcul du test suivant) : il faut
          // donc plus de marge que pour l'ancre abondante.
          await mintAndApprove(tokens, pool, other, amount * 2n);

          await pool.write.addLiquidity([2n, amount, 0n], { account: other.account });

          const mintedShares = await pool.read.balanceOf([other.account.address]);
          assert.equal(mintedShares, 37_500_000_000n);
        });

        it("a _amount identique, l'ancre rare preleve plus sur le troisieme token que l'ancre abondante", async function () {
          // amount = 100e8, reserves = [1250e8, 1000e8, 800e8]
          // ancre = token0 (abondant) : amounts[1] = amount * reserves[1] / reserves[0]
          //                                        = 10e9 * 1000e8 / 1250e8 = 8 000 000 000
          // ancre = token2 (rare)     : amounts[1] = amount * reserves[1] / reserves[2]
          //                                        = 10e9 * 1000e8 / 800e8  = 12 500 000 000
          // On lit les soldes reels plutot que de reappliquer la formule.
          const amount = 100n * 10n ** 8n;

          const abundant = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          await mintAndApprove(abundant.tokens, abundant.pool, abundant.other, amount);
          const token1BeforeAbundant = await abundant.tokens[1].read.balanceOf([abundant.other.account.address]);
          await abundant.pool.write.addLiquidity([0n, amount, 0n], { account: abundant.other.account });
          const token1AfterAbundant = await abundant.tokens[1].read.balanceOf([abundant.other.account.address]);
          const pulledAbundant = token1BeforeAbundant - token1AfterAbundant;

          // loadFixture restaure l'etat au snapshot (avant le depot ci-dessus)
          const rare = await networkHelpers.loadFixture(deployImbalancedPoolFixture);
          await mintAndApprove(rare.tokens, rare.pool, rare.other, amount * 2n);
          const token1BeforeRare = await rare.tokens[1].read.balanceOf([rare.other.account.address]);
          await rare.pool.write.addLiquidity([2n, amount, 0n], { account: rare.other.account });
          const token1AfterRare = await rare.tokens[1].read.balanceOf([rare.other.account.address]);
          const pulledRare = token1BeforeRare - token1AfterRare;

          assert.equal(pulledRare > pulledAbundant, true);
        });
      });
    });
  });
});
