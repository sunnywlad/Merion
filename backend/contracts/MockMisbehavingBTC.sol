// SPDX-License-Identifier: MIT

pragma solidity 0.8.36;

// Mock dedie a la couverture de SafeERC20 (G1). Ni ERC20Capped ni meme
// veritablement standard : ce contrat n'implemente PAS l'interface IERC20 au
// sens Solidity (transfer/transferFrom ne sont pas declares `override` d'une
// interface), precisement pour pouvoir choisir, a la ligne, ce que la
// fonction renvoie. Deux modes par fonction :
//   - False    : le transfert a bien lieu (les soldes bougent reellement),
//                mais la fonction renvoie explicitement `false`. C'est un
//                jeton qui SIGNALE un echec sans en etre un, le cas que
//                SafeERC20 doit rejeter.
//   - Nothing  : le transfert a bien lieu, mais la fonction ne renvoie
//                AUCUNE donnee du tout (via un `return` bas niveau qui
//                court-circuite l'encodage ABI habituel), a l'image de USDT
//                sur mainnet. C'est le cas que SafeERC20 doit accepter.
// Le mode par defaut (Normal) renvoie `true` comme un ERC-20 conforme : les
// tests qui amorcent le pool avant de basculer un mode l'utilisent.
//
// `_move` s'execute avant le choix du mode dans les deux branches non
// conformes : peu importe qu'un revert plus haut (SafeERC20FailedOperation)
// annule ensuite ce mouvement de solde, la mecanique testee est le choix de
// SafeERC20 face a la valeur de retour, pas la comptabilite du mock.
contract MockMisbehavingBTC {

  enum ReturnMode { Normal, False, Nothing }

  string public name;
  string public symbol;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  ReturnMode public transferMode;
  ReturnMode public transferFromMode;

  constructor(string memory _name, string memory _symbol) {
    name = _name;
    symbol = _symbol;
  }

  function decimals() public pure returns (uint8) {
    return 8;
  }

  function mint(address account, uint256 amount) external {
    balanceOf[account] += amount;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    return true;
  }

  function setTransferMode(ReturnMode mode) external {
    transferMode = mode;
  }

  function setTransferFromMode(ReturnMode mode) external {
    transferFromMode = mode;
  }

  function _move(address from, address to, uint256 amount) private {
    require(balanceOf[from] >= amount, "MockMisbehavingBTC: insufficient balance");
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _move(msg.sender, to, amount);

    if (transferMode == ReturnMode.Nothing) {
      // Bas niveau : aucune donnee de retour, meme pas un mot de 32 octets a
      // zero. C'est ce que SafeERC20._safeTransfer lit comme
      // `returndatasize() == 0`, la branche qu'il tolere.
      assembly {
        return(0, 0)
      }
    }
    return transferMode != ReturnMode.False;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= amount, "MockMisbehavingBTC: insufficient allowance");
    allowance[from][msg.sender] = allowed - amount;
    _move(from, to, amount);

    if (transferFromMode == ReturnMode.Nothing) {
      assembly {
        return(0, 0)
      }
    }
    return transferFromMode != ReturnMode.False;
  }
}
