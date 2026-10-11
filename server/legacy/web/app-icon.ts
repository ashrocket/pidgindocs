import appIcon from "./assets/app-icon.jpg";

export function appIconAsset(): Response {
  return new Response(appIcon, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
