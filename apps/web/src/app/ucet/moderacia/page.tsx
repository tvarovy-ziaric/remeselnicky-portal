import { ModerationActions } from "../../../moderation-actions";
import { AppShell, PageContainer } from "../../../design-system";
import {
  AuthenticatedHeader,
  MobileBottomNavigation,
} from "../../../site-shell";

export default function ModerationActionsPage() {
  return (
    <AppShell>
      <AuthenticatedHeader current="Profil a účet" />
      <main className="site-main" id="main-content">
        <section>
          <PageContainer>
            <ModerationActions />
          </PageContainer>
        </section>
      </main>
      <MobileBottomNavigation current="Profil a účet" />
    </AppShell>
  );
}
