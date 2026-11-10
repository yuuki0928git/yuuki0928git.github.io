export function safePath(p) {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length < 1000 &&
    !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.split("/").some((x) => x === "." || x === "..") &&
    !/[\x00-\x1f]/.test(p)
  );
}
