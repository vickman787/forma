import Link from "next/link";
import { Check, Plus, Sparkles } from "lucide-react";
import {
  Header,
  MiniArtwork,
  ServiceIcon,
  Logo,
  GenerationNote,
} from "@/components/studio";
import { services } from "@/lib/domain";
export default function Home() {
  return (
    <>
      <div className="landing">
        <Header />
        <main id="main-content">
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="eyebrow-line" />A little help. A bigger
                business.
              </div>
              <h1>
                Your next big idea.
                <br />
                <em>Ready to launch.</em>
              </h1>
              <p>
                Websites, videos, flyers, and market insights.
                <br className="desktop-break" /> Give your business the creative
                team it deserves.
              </p>
              <Link className="button" href="#services">
                Find your starting point <Plus size={17} />
              </Link>
              <div className="hero-caption">
                <span className="small-star">✳</span> Your ideas. A little more
                possible.
              </div>
            </div>
            <div className="hero-collage">
              <div className="hero-site">
                <MiniArtwork service="business_website" hero />
              </div>
              <div className="hero-flyer">
                <MiniArtwork service="flyers_price_list" hero />
              </div>
              <div className="hero-chart">
                <span>YOUR NEXT OPPORTUNITY</span>
                <div className="chart-bars">
                  {[27, 48, 41, 65, 86, 73].map((h, i) => (
                    <i key={i} style={{ height: h + "%" }} />
                  ))}
                </div>
              </div>
              <span className="collage-spark">✳</span>
              <span className="collage-caption">
                A few possibilities, made tangible.
              </span>
            </div>
          </section>
          <section id="services" className="services-section">
            <div className="section-heading">
              <div>
                <span className="eyebrow">
                  The things you need. Made simple.
                </span>
                <h2>What are we making today?</h2>
              </div>
              <p>Four services. One simple starting point.</p>
            </div>
            <div className="service-grid">
              {services.map((s, i) => (
                <Link
                  href={"/new?service=" + s.id}
                  className="service-card"
                  key={s.id}
                >
                  <MiniArtwork service={s.id} />
                  <div className="service-card-body">
                    <div className="service-card-title">
                      <h3>{s.name}</h3>
                      <ServiceIcon id={s.id} size={19} />
                    </div>
                    <p>
                      {s.short}
                      <br />
                      {s.description}
                    </p>
                    <div className="service-card-price">
                      <div>
                        <strong>
                          1 <small>QUSDC</small>
                        </strong>
                        <span>Approximately $1 · launch price</span>
                      </div>
                      <span className="card-plus">
                        <Plus size={19} />
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
            <p className="studio-note">
              <Sparkles size={14} /> Your creative studio <span>·</span>{" "}
              <GenerationNote />
            </p>
          </section>
          <section className="how-strip" id="how-it-works">
            <strong>From brief to better business</strong>
            <div>
              <span>01</span>Tell us what you need
            </div>
            <div>
              <span>02</span>We make it happen
            </div>
            <div>
              <span>03</span>Review your delivery
            </div>
          </section>
          <section className="landing-bottom">
            <div>
              <span className="eyebrow">
                Less back-and-forth. More getting started.
              </span>
              <h2>
                A little brief.
                <br />A meaningful beginning.
              </h2>
            </div>
            <div>
              <p>
                Bring your business details. Keep your brand, prices, and
                contact information exactly yours. Follow each step, then review
                the files before accepting.
              </p>
              <Link className="text-link" href="/help">
                Get to know your studio <Plus size={16} />
              </Link>
            </div>
          </section>
        </main>
        <footer className="site-footer">
          <Logo />
          <span>Made for the businesses making things happen.</span>
          <Link href="/help">Scope & payment terms</Link>
        </footer>
      </div>
    </>
  );
}
