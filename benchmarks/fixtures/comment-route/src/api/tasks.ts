// export function ghost() { return request("/api/tasks", { method: "GET" }); }
export function listTasks() {
  return request("/api/tasks", { method: "GET" });
}
