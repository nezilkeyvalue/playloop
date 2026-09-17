import { redirect } from "next/navigation";

export default async function StatsRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/games/${id}/analytics`);
}
