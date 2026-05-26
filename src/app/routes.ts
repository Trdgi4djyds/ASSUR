import { createBrowserRouter, redirect } from "react-router";
import { Layout } from "./components/Layout";
import { HomePage } from "./components/HomePage";
import { ProductsPage } from "./components/ProductsPage";
import { ProductDetailPage } from "./components/ProductDetailPage";
import { CarteIppooPage } from "./components/CarteIppooPage";
import { CommentCaMarchePage } from "./components/CommentCaMarchePage";
import { PointsPartenairesPage } from "./components/PointsPartenairesPage";
import { FaqPage } from "./components/FaqPage";
import { ContactPage } from "./components/ContactPage";
import { MentionsLegalesPage } from "./components/MentionsLegalesPage";
import { ConfidentialitePage } from "./components/ConfidentialitePage";
import { ConditionsGeneralesPage } from "./components/ConditionsGeneralesPage";
import { MediateurPage } from "./components/MediateurPage";
import { DevisPage } from "./components/DevisPage";
import { SinistrePage } from "./components/SinistrePage";
import { EspacePage } from "./components/EspacePage";
import { AProposPage } from "./components/AProposPage";
import { InscriptionPage } from "./components/InscriptionPage";
import { HydrateFallback } from "./components/HydrateFallback";

// Espace client is fully code-split none of these chunks load on the public marketing site.
const lazyEspaceLayout = () => import("./espace-client/EspaceLayout").then((m) => ({ Component: m.EspaceLayout }));
const lazyEspacePublic = () => import("./espace-client/EspaceLayout").then((m) => ({ Component: m.EspacePublicLayout }));
const lazyAdminLayout = () => import("./espace-client/AdminLayout").then((m) => ({ Component: m.AdminLayout }));
const lazyPage = (loader: () => Promise<Record<string, any>>, name: string) =>
  () => loader().then((m) => ({ Component: m[name] }));

export const router = createBrowserRouter([
  {
    path: "/",
    Component: Layout,
    HydrateFallback,
    children: [
      { index: true, Component: HomePage },
      { path: "produits", Component: ProductsPage },
      { path: "produits/:slug", Component: ProductDetailPage },
      { path: "carte-ippoo", Component: CarteIppooPage },
      { path: "comment-ca-marche", Component: CommentCaMarchePage },
      { path: "points-partenaires", Component: PointsPartenairesPage },
      { path: "faq", Component: FaqPage },
      { path: "contact", Component: ContactPage },
      { path: "devis", Component: DevisPage },
      { path: "sinistre", Component: SinistrePage },
      { path: "espace", Component: EspacePage },
      { path: "a-propos", Component: AProposPage },
      { path: "inscription", Component: InscriptionPage },
      { path: "mentions-legales", Component: MentionsLegalesPage },
      { path: "confidentialite", Component: ConfidentialitePage },
      { path: "conditions-generales", Component: ConditionsGeneralesPage },
      { path: "mediateur", Component: MediateurPage },
      { path: "*", Component: HomePage },
    ],
  },
  {
    path: "/espace-client",
    HydrateFallback,
    lazy: lazyEspacePublic,
    children: [
      { path: "connexion", lazy: lazyPage(() => import("./espace-client/pages/ConnexionPage"), "ConnexionPage") },
      { path: "inscription", loader: () => { throw redirect("/inscription"); } },
    ],
  },
  {
    path: "/espace-client",
    HydrateFallback,
    lazy: lazyEspaceLayout,
    children: [
      { index: true, lazy: lazyPage(() => import("./espace-client/pages/DashboardPage"), "DashboardPage") },
      { path: "contrats", lazy: lazyPage(() => import("./espace-client/pages/ContratsPage"), "ContratsPage") },
      { path: "sinistres", lazy: lazyPage(() => import("./espace-client/pages/SinistresPage"), "SinistresPage") },
      { path: "cotisations", lazy: lazyPage(() => import("./espace-client/pages/CotisationsPage"), "CotisationsPage") },
      { path: "profil", lazy: lazyPage(() => import("./espace-client/pages/ProfilPage"), "ProfilPage") },
      { path: "beneficiaires", lazy: lazyPage(() => import("./espace-client/pages/BeneficiairesPage"), "BeneficiairesPage") },
      { path: "documents", lazy: lazyPage(() => import("./espace-client/pages/DocumentsPage"), "DocumentsPage") },
      { path: "messagerie", lazy: lazyPage(() => import("./espace-client/pages/MessageriePage"), "MessageriePage") },
      { path: "notifications", lazy: lazyPage(() => import("./espace-client/pages/NotificationsPage"), "NotificationsPage") },
      { path: "souscription", lazy: lazyPage(() => import("./espace-client/pages/SouscriptionPage"), "SouscriptionPage") },
      { path: "carte", lazy: lazyPage(() => import("./espace-client/pages/CartePage"), "CartePage") },
      { path: "parametres", lazy: lazyPage(() => import("./espace-client/pages/ParametresPage"), "ParametresPage") },
      { path: "onboarding", lazy: lazyPage(() => import("./espace-client/pages/OnboardingPage"), "OnboardingPage") },
      { path: "partenaires", lazy: lazyPage(() => import("./espace-client/pages/PartenairesPage"), "PartenairesPage") },
    ],
  },
  {
    path: "/admin",
    HydrateFallback,
    lazy: lazyAdminLayout,
    children: [
      { index: true, lazy: lazyPage(() => import("./espace-client/pages/AdminPage"), "AdminPage") },
    ],
  },
]);
