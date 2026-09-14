import { AdminShellClient } from "../../../admin-shell-client";

export default async function AdminModulePage({
  params,
}: Readonly<{ params: Promise<{ moduleId: string }> }>) {
  const { moduleId } = await params;
  return <AdminShellClient requestedModuleId={moduleId} />;
}
