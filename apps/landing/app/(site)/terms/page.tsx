// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { LANDING_URL } from "@/lib/urls";

export const metadata = {
  title: "Terms of Service",
  description:
    "Terms of Service for DataBounty Community, including community roles, requests, submissions, validation, recognition, acceptable use, and legal terms.",
  alternates: { canonical: `${LANDING_URL}/terms` },
};

const UPDATED = "August 28, 2026";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-dark-line py-8">
      <h2 className="font-mono text-xl font-bold text-dark-text">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-dark-muted">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <main className="bg-dark text-dark-text">
      <section className="mx-auto max-w-[900px] px-4 py-16 sm:px-8 lg:py-20">
        <div className="mb-8 font-mono text-xs text-lime">legal/terms</div>
        <h1 className="font-mono text-[34px] font-bold leading-tight text-dark-text sm:text-[44px]">
          Terms of Service (Community)
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-8 text-dark-muted">
          DataBounty Community lets people request, contribute to, and validate open datasets together, and earn public recognition for accepted work. These Terms govern your use of the DataBounty Community website, dashboard, admin console (if you operate it), and API.
        </p>
        <p className="mt-5 font-mono text-xs text-dark-dim">Last updated: {UPDATED}</p>

        <Section title="1. Agreement to Terms">
          <p>
            DataBounty is operated by [X]CUBE LABS PTE. LTD., Singapore. By accessing or using DataBounty Community, you agree to these Terms. If you use it on behalf of an organization, you confirm you have the authority to bind that organization.
          </p>
        </Section>

        <Section title="2. Roles">
          <p>
            DataBounty Community supports several roles. <strong>Sponsors</strong> propose Community requests describing a dataset they want built. <strong>Contributors</strong> submit dataset items against an open request. <strong>Validators</strong> independently review submitted work. <strong>Community operators</strong> run and moderate the platform. One account may hold more than one role. You are responsible for activity under your account and for keeping your credentials secure.
          </p>
          <p>
            You are responsible for the activity under your account and
            connected integrations, and for ensuring that your use of DataBounty
            Community complies with these Terms and applicable law.
          </p>
        </Section>

        <Section title="3. Accounts and Eligibility">
          <p>
            You must provide accurate account information, protect your
            credentials, and promptly update account details when needed. Your
            account, session, connected sign-in provider (such as Google), OAuth
            accounts, and other credentials may be used for authentication,
            attribution, and abuse prevention.
          </p>
          <p>
            We may require additional verification, sanctions, identity, or
            compliance information before enabling certain features or limits.
          </p>
        </Section>

        <Section title="4. Community Requests and Pools">
          <p>
            A Sponsor&apos;s request describes what dataset is needed, its target size, its license, and how contributed items will be validated. Once approved, a request opens as a pool that Contributors add work to.
          </p>
          <p>
            Sponsors are responsible for the accuracy and legality of request
            specifications, requested datasets, license requirements, and
            acceptance criteria.
          </p>
        </Section>

        <Section title="5. Submissions and Validation">
          <p>
            Contributors must submit original, lawful, request-compliant work and
            disclose AI assistance or generation where required by the request.
            Submissions may be checked for duplicates, policy violations, test
            execution, LLM review, and independent human review.
          </p>
          <p>
            Passing one validation layer does not guarantee acceptance if another
            layer later identifies an issue. We may reject, hold, audit, remove,
            or reclassify submissions to protect dataset quality and safety.
          </p>
        </Section>

        <Section title="6. Licenses and Ownership">
          <p>
            You retain rights you already own in your submitted materials, but by
            submitting work to a Community request you grant DataBounty, the
            requesting Sponsor, and other applicable participants the rights
            needed to host, validate, audit, display, license, publish, and use
            the work according to the request terms and platform workflow.
          </p>
          <p>
            Accepted work is published under the open license named in the
            request, with contributor credit unless you opt out. You must not
            submit material that infringes another party&apos;s rights, violates
            confidentiality obligations, or cannot be released under that license.
          </p>
        </Section>

        <Section title="7. Recognition">
          <p>
            Accepted work earns community recognition — public credit, a contribution record on your profile, and karma/tier standing visible to others who choose to make that visible.
          </p>
        </Section>

        <Section title="8. Acceptable Use">
          <p>
            You may not use DataBounty Community to submit malware, exploit code
            intended for abuse, stolen data, private personal information without
            rights, benchmark leaks presented as original work, plagiarized or
            contamination-tainted material presented as original, spam,
            fraudulent activity, manipulation, harassment, illegal content, or
            material that violates third-party rights.
          </p>
          <p>
            You may not interfere with the service, bypass access controls, abuse
            validation systems, manipulate reputation or audits, use multiple
            accounts to evade limits, scrape where prohibited, or attempt
            unauthorized access to DataBounty Community or its providers.
          </p>
        </Section>

        <Section title="9. Third-Party Services">
          <p>
            DataBounty Community may rely on third-party services for
            authentication, hosting, storage, analytics, email, validation,
            sandbox execution, and integrations. Your use of those services may be
            subject to their own terms and policies.
          </p>
        </Section>

        <Section title="10. Suspension and Enforcement">
          <p>
            We may suspend, limit, or terminate access; remove content; or take
            other reasonable action if we believe there is fraud, abuse, legal
            risk, security risk, policy violation, or harm to the platform.
          </p>
        </Section>

        <Section title="11. Disclaimers">
          <p>
            DataBounty Community is provided &ldquo;as is&rdquo; and &ldquo;as
            available.&rdquo; We do not guarantee uninterrupted availability,
            error-free operation, specific platform results, specific dataset
            quality, or that every validation decision will be correct.
          </p>
        </Section>

        <Section title="12. Limitation of Liability">
          <p>
            To the fullest extent permitted by law, DataBounty and [X]CUBE LABS
            PTE. LTD., Singapore will not be liable for indirect, incidental,
            special, consequential, exemplary, or punitive damages, or lost
            profits, revenues, data, goodwill, or business opportunities.
          </p>
        </Section>

        <Section title="13. Changes to These Terms">
          <p>
            We may update these Terms from time to time. If we make material
            changes, we will update the date above and may provide additional
            notice. Continued use of DataBounty Community after changes become
            effective means you accept the updated Terms.
          </p>
        </Section>

        <Section title="14. Contact">
          <p>
            Questions about these Terms can be sent through DataBounty support channels. Please also review our{" "}
            <Link href="/privacy" className="text-lime hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </Section>
      </section>
    </main>
  );
}
