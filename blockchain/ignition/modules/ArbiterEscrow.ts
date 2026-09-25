import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
const ArbiterEscrowModule = buildModule("ArbiterEscrowModule", (m) => {
  // Require an explicit oracle; never deploy a live contract with a public test key as authority.
  const oracleAddress = m.getParameter("oracleAddress");
  const escrow = m.contract("ArbiterEscrow", [oracleAddress]);
  // For testing purposes on local networks/testnets, we also deploy the MockUSDC and MockFeeToken
  const mockUSDC = m.contract("MockUSDC");
  const mockFeeToken = m.contract("MockFeeToken");
  return { escrow, mockUSDC, mockFeeToken };
});
export default ArbiterEscrowModule;
