export function login(user: string, pass: string): boolean {
  return verify(user, pass);
}
function verify(user: string, pass: string): boolean {
  return user.length > 0 && pass.length >= 4;
}
