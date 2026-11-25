// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// Local EVM fixture only; never part of the deployed escrow bundle.
contract AdversarialToken is ERC20 {
    uint8 public mode;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    constructor() ERC20("Adversarial fixture", "FIXTURE") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function configure(uint8 value, address target, bytes calldata data) external {
        mode = value; callbackTarget = target; callbackData = data;
    }
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (mode == 1) return false;
        if (mode == 2) { _spendAllowance(from, msg.sender, value); _transfer(from, to, value - 1); _burn(from, 1); return true; }
        if (mode == 3) (callbackSucceeded,) = callbackTarget.call(callbackData);
        return super.transferFrom(from, to, value);
    }
    function transfer(address to, uint256 value) public override returns (bool) {
        if (mode == 4) return false;
        if (mode == 3) (callbackSucceeded,) = callbackTarget.call(callbackData);
        return super.transfer(to, value);
    }
}
