declare module "*.css";
declare module "*.png" {
  const src: string;
  export default src;
}
declare module "*.js" {
  const src: string;
  export default src;
}
/* JSON files imported with `with { type: "file" }` (the boundary
   data files) resolve to their emitted asset URL, not parsed JSON. */
declare module "*.json" {
  const src: string;
  export default src;
}
