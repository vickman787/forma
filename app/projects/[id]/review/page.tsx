import { Project } from "@/components/project";
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return <Project id={(await params).id} view="review" />;
}
