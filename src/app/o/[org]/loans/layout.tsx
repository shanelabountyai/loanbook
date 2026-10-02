import { IBM_Plex_Mono, IBM_Plex_Sans, Source_Serif_4 } from 'next/font/google';
import './ledger.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-sans' });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-mono' });
const serif = Source_Serif_4({ subsets: ['latin'], weight: ['500', '600'], variable: '--font-serif' });

// The loan screens' shell: design tokens and the scope-honesty banner (verbatim from README.md) on every screen.
export default function LoansLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`lb ${sans.variable} ${mono.variable} ${serif.variable}`}>
      <div role="note" className="scope">
        <p className="wrap">
          <strong>Scope honesty:</strong> Learning project, synthetic data only. Real lending is regulated (TILA/Reg Z disclosures, state usury caps, servicing rules); this project models the <em>accounting mechanics</em>, makes no compliance claims, and must never touch real borrowers or real money.
        </p>
      </div>
      {children}
    </div>
  );
}
