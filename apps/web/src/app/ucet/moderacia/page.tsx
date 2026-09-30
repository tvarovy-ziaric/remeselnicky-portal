import { ModerationActions } from "../../../moderation-actions";
import { AppShell, PageContainer } from "../../../design-system";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export default function ModerationActionsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader context="CRAFTSMAN" current="Profil" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <ModerationActions />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation context="CRAFTSMAN" current="Profil" />
    </AppShell>
  );
}
