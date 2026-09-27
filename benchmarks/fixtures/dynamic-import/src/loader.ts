export async function load() {
  const mod = await import("./target");
  return mod.go();
}
