// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Fixed-asset, fixed-treasury service escrow. No upgrade or token recovery.
contract ServiceEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum State { Missing, Created, Funded, Delivered, Released, Refunded }
    struct Job { address customer; uint256 amount; bytes32 termsHash; bytes32 manifestHash; uint64 fundingExpiry; uint64 deliveryDeadline; uint64 reviewDeadline; State state; }
    IERC20 public immutable asset;
    address public immutable treasury;
    address public immutable operator;
    uint256 public liabilities;
    uint64 public constant DELIVERY_WINDOW = 24 hours;
    uint64 public constant REVIEW_WINDOW = 48 hours;
    mapping(bytes32 => Job) public jobs;
    error Unauthorized(); error InvalidState(); error InvalidTerms(); error Deadline(); error TransferMismatch();
    event JobCreated(bytes32 indexed jobId, address indexed customer, uint256 amount, bytes32 termsHash, uint64 fundingExpiry);
    event JobFunded(bytes32 indexed jobId, address indexed customer, address indexed token, uint256 amount);
    event DeliverySubmitted(bytes32 indexed jobId, bytes32 manifestHash, uint64 reviewDeadline);
    event JobReleased(bytes32 indexed jobId, address indexed treasury, uint256 amount);
    event JobRefunded(bytes32 indexed jobId, address indexed customer, uint256 amount);
    modifier onlyOperator() { if(msg.sender!=operator) revert Unauthorized(); _; }
    constructor(IERC20 token,address treasury_,address operator_) { if(address(token)==address(0)||treasury_==address(0)||operator_==address(0))revert InvalidTerms();asset=token;treasury=treasury_;operator=operator_; }
    function createJob(bytes32 id,address customer,uint256 amount,bytes32 termsHash,uint64 expiry) external onlyOperator {
        if(jobs[id].state!=State.Missing)revert InvalidState();
        if(customer==address(0)||amount!=1_000_000||termsHash==bytes32(0)||expiry<=block.timestamp||expiry>block.timestamp+30 minutes)revert InvalidTerms();
        jobs[id]=Job(customer,amount,termsHash,bytes32(0),expiry,0,0,State.Created);emit JobCreated(id,customer,amount,termsHash,expiry);
    }
    function fundJob(bytes32 id) external nonReentrant { Job storage j=jobs[id];if(j.state!=State.Created)revert InvalidState();if(msg.sender!=j.customer)revert Unauthorized();if(block.timestamp>=j.fundingExpiry)revert Deadline();j.state=State.Funded;j.deliveryDeadline=uint64(block.timestamp)+DELIVERY_WINDOW;liabilities+=j.amount;uint256 beforeBalance=asset.balanceOf(address(this));asset.safeTransferFrom(msg.sender,address(this),j.amount);if(asset.balanceOf(address(this))-beforeBalance!=j.amount)revert TransferMismatch();emit JobFunded(id,j.customer,address(asset),j.amount); }
    function submitDelivery(bytes32 id,bytes32 manifestHash) external onlyOperator {Job storage j=jobs[id];if(j.state!=State.Funded)revert InvalidState();if(block.timestamp>=j.deliveryDeadline)revert Deadline();if(manifestHash==bytes32(0))revert InvalidTerms();j.manifestHash=manifestHash;j.state=State.Delivered;j.reviewDeadline=uint64(block.timestamp)+REVIEW_WINDOW;emit DeliverySubmitted(id,manifestHash,j.reviewDeadline);}
    function acceptDelivery(bytes32 id) external nonReentrant {Job storage j=jobs[id];if(msg.sender!=j.customer)revert Unauthorized();if(j.state!=State.Delivered)revert InvalidState();_release(id,j);}
    function claimReviewRelease(bytes32 id) external nonReentrant {Job storage j=jobs[id];if(j.state!=State.Delivered)revert InvalidState();if(block.timestamp<j.reviewDeadline)revert Deadline();_release(id,j);}
    function refundJob(bytes32 id) external onlyOperator nonReentrant {Job storage j=jobs[id];if(j.state!=State.Funded&&j.state!=State.Delivered)revert InvalidState();_refund(id,j);}
    function claimLateRefund(bytes32 id) external nonReentrant {Job storage j=jobs[id];if(msg.sender!=j.customer)revert Unauthorized();if(j.state!=State.Funded)revert InvalidState();if(block.timestamp<j.deliveryDeadline)revert Deadline();_refund(id,j);}
    function _release(bytes32 id,Job storage j) private {j.state=State.Released;liabilities-=j.amount;asset.safeTransfer(treasury,j.amount);emit JobReleased(id,treasury,j.amount);}
    function _refund(bytes32 id,Job storage j) private {j.state=State.Refunded;liabilities-=j.amount;asset.safeTransfer(j.customer,j.amount);emit JobRefunded(id,j.customer,j.amount);}
}
