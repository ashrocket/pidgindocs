declare module "*.woff" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
declare module "*.otf" {
  const data: ArrayBuffer;
  export default data;
}
declare module "@resvg/resvg-wasm/index_bg.wasm" {
  const wasm: WebAssembly.Module;
  export default wasm;
}
