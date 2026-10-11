import satori from "satori";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import resvgWasm from "@resvg/resvg-wasm/index_bg.wasm";
import interSemiBold from "../../fonts/Inter-SemiBold.woff";
import interBold from "../../fonts/Inter-Bold.woff";

let wasmReady: Promise<void> | null = null;

async function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasm as WebAssembly.Module);
  }
  await wasmReady;
}

interface PreviewOptions {
  title: string;
  subtitle?: string;
}

export async function renderPreviewPng(opts: PreviewOptions): Promise<Uint8Array> {
  const title = opts.title || "Shared document";
  const subtitle = opts.subtitle || "Shared via PidginDocs";

  const card = {
    type: "div",
    props: {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px",
        background: "linear-gradient(135deg, #FBF7F0 0%, #F0DDD6 100%)",
        fontFamily: "Inter",
      },
      children: [
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              alignItems: "center",
              fontSize: 28,
              fontWeight: 600,
              color: "#C1654A",
              letterSpacing: 3,
              textTransform: "uppercase",
            },
            children: "PidginDocs",
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              flexDirection: "column",
              fontSize: 64,
              fontWeight: 700,
              color: "#3D2E2A",
              lineHeight: 1.1,
              maxWidth: "100%",
            },
            children: title.slice(0, 140),
          },
        },
        {
          type: "div",
          props: {
            style: {
              display: "flex",
              fontSize: 24,
              fontWeight: 600,
              color: "#8A7672",
            },
            children: subtitle.slice(0, 120),
          },
        },
      ],
    },
  };

  const svg = await satori(card as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [
      {
        name: "Inter",
        data: interSemiBold as unknown as ArrayBuffer,
        weight: 600,
        style: "normal",
      },
      {
        name: "Inter",
        data: interBold as unknown as ArrayBuffer,
        weight: 700,
        style: "normal",
      },
    ],
  });

  await ensureWasm();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1200 },
  });
  return resvg.render().asPng();
}
