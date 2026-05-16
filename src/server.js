// ===== server.js PATCH =====

// Sau khi gọi fetchDepositRemarkByUsername()

const depositInfo = await fetchDepositRemarkByUsername(username);

// Approved -> STOP
if (depositInfo?.isApproved === true) {
  return res.json({
    ok: true,
    alreadyPaid: true,
    status: "Đã lên điểm thành công",
    message: "Đã lên điểm thành công",
    orderCode: depositInfo?.remarks || "-",
  });
}

// Không Approved
// => gửi CSKH
// => bot tự forward sang T3 tương ứng
