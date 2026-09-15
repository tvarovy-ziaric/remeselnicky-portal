import { appInfo } from "../app-info";

export default function HomePage() {
  return (
    <main>
      <section aria-labelledby="page-title">
        <p className="eyebrow">Web Alpha</p>
        <h1 id="page-title">{appInfo.name}</h1>
        <p>{appInfo.description}</p>
        <nav className="home-actions" aria-label="Hlavné možnosti">
          <a href="/dopyt">Vytvoriť dopyt</a>
          <a href="/remeselnici">Nájsť remeselníka</a>
        </nav>
        <p className="contract">Zdieľaný kontrakt API: {appInfo.apiVersion}</p>
      </section>
    </main>
  );
}
