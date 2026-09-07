/** Compact Terms of Service and Privacy Policy for the web client. */

import { Link } from 'react-router-dom';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="legal-page">
      <Link to="/" className="shop-back">← Game Night</Link>
      <h1>{title}</h1>
      <div className="legal-body">{children}</div>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <Shell title="Privacy Policy">
      <p><em>Plain-language summary — the short version a real person can read.</em></p>
      <h2>What we collect</h2>
      <ul>
        <li><strong>Gameplay data</strong>: room codes, chat messages, and game moves while you play. Chat is ephemeral — it lives with the room and expires when the room does.</li>
        <li><strong>Cosmetics profile</strong>: a random token stored in your browser plus your owned/equipped cosmetics and rounds-played count. No email, no name, no phone number.</li>
        <li><strong>Voice &amp; video</strong>: peer-to-peer only. Audio/video flows directly between players' browsers and is never recorded, stored, or relayed through our servers — our server only helps browsers find each other.</li>
        <li><strong>Anonymous analytics</strong> (optional, self-hosted): page views and funnel events, no cross-site tracking, no ad networks.</li>
        <li><strong>Payments</strong>: handled entirely by Stripe. We never see card numbers; we store only the fact that an entitlement was granted.</li>
      </ul>
      <h2>What we don't do</h2>
      <ul>
        <li>No selling of data. No advertising. No third-party trackers.</li>
      </ul>
      <h2>Deleting your data</h2>
      <p>Leave a room and the room's data expires on its own (currently within hours). To delete a cosmetics profile, clear your browser storage for this site, or contact us and we'll wipe the server-side copy.</p>
    </Shell>
  );
}

export function TosPage() {
  return (
    <Shell title="Terms of Service">
      <p><em>Plain-language summary — the short version a real person can read.</em></p>
      <h2>Using the game</h2>
      <ul>
        <li>Play nice: no harassment, hate speech, spam, or cheating (including tools that read hidden game state).</li>
        <li>You're responsible for what you say in chat and do on voice/video. Don't record other players without their consent.</li>
        <li>We may remove content or restrict access for abuse.</li>
      </ul>
      <h2>Purchases</h2>
      <ul>
        <li>Cosmetics are cosmetic: they never affect game outcomes.</li>
        <li>Purchases are one-time, non-transferable, and tied to your browser profile. Refunds handled case-by-case within 14 days if the entitlement was never used — contact support.</li>
      </ul>
      <h2>The service</h2>
      <ul>
        <li>The game is provided "as is". We aim for high availability but don't guarantee it; features may change.</li>
        <li>You must be old enough to consent to online services in your jurisdiction.</li>
      </ul>
    </Shell>
  );
}
