/** Home and Library are kept once visited rather than routed (Pages); this says which one a path shows. */
export function keptPlace(pathname: string) {
  const path = pathname.replace(/(.)\/+$/, "$1");
  return path === "/" ? "home" : path === "/library" ? "library" : null;
}
