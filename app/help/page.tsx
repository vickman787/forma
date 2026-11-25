import { Workspace } from "@/components/studio";
import { services, terms } from "@/lib/domain";
import { supportEmail } from "@/lib/support";
export const dynamic = "force-dynamic";
export default function Page() {
  const email = supportEmail();
  return (
    <Workspace title="Help & guides">
      <div className="page-title" id="main-content">
        <div>
          <span className="eyebrow">A little clarity</span>
          <h1>Good to know before you go.</h1>
          <p>
            Your scope, your files, and a clear understanding of what happens
            next.
          </p>
        </div>
      </div>
      <div className="help-grid">
        <section className="panel full">
          <h2>Need a hand?</h2>
          <p>
            Use “Report a problem” in your project to save an issue against your
            order.
          </p>
          {email ? (
            <p>
              Email{" "}
              <a className="text-link" href={`mailto:${email}`}>
                {email}
              </a>{" "}
              with your project ID for help. Never send a private key or seed
              phrase.
            </p>
          ) : null}
        </section>
        <section className="panel">
          <h2>A brief that feels like you.</h2>
          <p>
            Tell us what your business does, who it serves, and the next action
            you want a customer to take. Use approved contact details and exact
            prices. Upload only photos and logos you own or have permission to
            use.
          </p>
          <h3>Your reusable brand kit</h3>
          <p>
            Save your shared details from the brief screen. Choose “Use this
            kit” when you want to reuse them. Kits are private to the account
            that created them.
          </p>
        </section>
        <section className="panel">
          <h2>One clear starting price.</h2>
          <p>
            Each service has a launch price of 1 QUSDC · approximately $1. This
            is not a guarantee of QUSDC’s market value. QIE network fees are
            separate.
          </p>
          <p>
            Live customers must already hold QUSDC and enough QIE on QIE Mainnet
            (chain 1990). Forma does not provide bridging, minting, swaps, or
            fiat purchases.
          </p>
          <p className="fine break">
            QUSDC: {terms.token}
            <br />6 decimals · 1,000,000 base units per service
          </p>
        </section>
        <section className="panel">
          <h2>Your payment & review terms.</h2>
          <p>{terms.text}</p>
          <p>
            A problem report is saved for the operator to review; it does not
            pause the deadline or guarantee a refund. The operator may refund a
            genuine failure before settlement. There is no automatic unilateral
            refund after receiving delivery.
          </p>
        </section>
        <section className="panel">
          <h2>Your wallet and your files.</h2>
          <p>
            Sign in with your wallet to access your private workspace. Signing
            in does not send funds. Payments require your wallet confirmation
            and a verified on-chain receipt.
          </p>
          <p>
            If generation or checkout is unavailable, your brief remains saved
            and no replacement output is generated.
          </p>
          <p>
            QUSDC’s backing, redemption, and bridge risks have not been
            independently audited by Forma.
          </p>
        </section>
        <section className="panel full">
          <h2>What’s included?</h2>
          <div className="help-services">
            {services.map((s) => (
              <div key={s.id}>
                <h3>{s.name}</h3>
                <ul>
                  {s.outputs.map((output) => (
                    <li key={output}>{output}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="fine">
            No custom domains, multi-page sites, store backend, voiceover,
            soundtrack, square video export, or included revisions in this
            release. Technical checks do not guarantee commercial results.
          </p>
        </section>
      </div>
    </Workspace>
  );
}
