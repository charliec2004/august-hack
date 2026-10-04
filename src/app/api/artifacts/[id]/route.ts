import { loadArtifact } from "@/server/artifacts";
import { currentUser } from "@/server/auth/currentUser";

export const dynamic = "force-dynamic";

/** Raster images may render inline (thumbnails); everything else downloads. */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Downloads one of the user's files (digest-verified out of object storage). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  let art;
  try {
    art = await loadArtifact(user.id, id);
  } catch {
    return Response.json({ error: "Couldn't load this file right now." }, { status: 502 });
  }
  if (!art) return Response.json({ error: "Not found." }, { status: 404 });
  const inline = new URL(req.url).searchParams.get("inline") === "1" && INLINE_TYPES.has(art.mediaType);
  const name = art.filename.replace(/["\\\r\n]/g, "_");
  return new Response(new Uint8Array(art.bytes), {
    headers: {
      "Content-Type": art.mediaType,
      "Content-Length": String(art.bytes.length),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(art.filename)}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
