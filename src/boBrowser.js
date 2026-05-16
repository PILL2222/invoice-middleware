// ===== boBrowser.js PATCH =====

// Ưu tiên Approved trong Deposit trước
const approvedDeposit = depositList.find(d =>
  d.remarks && Number(d.status) === 1
);

const match =
  approvedDeposit ||
  depositList.find(d => d.remarks) ||
  auditList.find(d => d.remarks) ||
  depositList[0] ||
  auditList[0];

if (match) {
  const statusFields = [
    match.statusStr,
    match.statusEnum,
    match.statusName,
    match.statusDisplay,
  ].join(" ").toLowerCase();

  const isApproved =
    Number(match.status) === 1 ||
    statusFields.includes("approved");

  const isExpired =
    Number(match.status) === 7 ||
    statusFields.includes("expired");

  logger.info("BO deposit found", {
    username,
    remarks: match.remarks,
    status: match.status,
    isApproved,
    isExpired,
  });

  return {
    remarks: match.remarks || "-",
    status: match.status,
    isApproved,
    isExpired,
  };
}
