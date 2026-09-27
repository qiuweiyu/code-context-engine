export function fetchUsers() {
  return request("/api/users", { method: "GET" });
}
