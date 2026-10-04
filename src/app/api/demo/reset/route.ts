import { currentUser } from "@/server/auth/currentUser";
import { resetDemoUser } from "@/server/demo/reset";

export async function POST() {
  if (process.env.AUGUST_ENV === "production") return Response.json({ error: "disabled" }, { status: 404 });
  const user = await currentUser();
  await resetDemoUser(user.authSubject);
  return Response.json({ ok: true });
}
