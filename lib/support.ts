export function supportEmail() {
  const email = process.env.SUPPORT_EMAIL?.trim() || "";
  return /^[^\s@?&#]+@[^\s@?&#]+\.[^\s@?&#]+$/.test(email) ? email : null;
}
