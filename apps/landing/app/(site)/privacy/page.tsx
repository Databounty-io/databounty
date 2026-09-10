// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { LANDING_URL } from "@/lib/urls";

export const metadata = {
  title: "Privacy Policy",
  description:
    "Privacy Policy for DataBounty Community, explaining data collection, use, sharing, retention, and choices across the platform.",
  alternates: { canonical: `${LANDING_URL}/privacy` },
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

export default function PrivacyPage() {
  return (
    <main className="bg-dark text-dark-text">
      <section className="mx-auto max-w-[900px] px-4 py-16 sm:px-8 lg:py-20">
        <div className="mb-8 font-mono text-xs text-lime">legal/privacy</div>
        <h1 className="font-mono text-[34px] font-bold leading-tight text-dark-text sm:text-[44px]">
          Privacy Policy (Community)
        </h1>
        <p className="mt-4 max-w-3xl text-base leading-8 text-dark-muted">
          This Privacy Policy explains how DataBounty Community collects, uses, discloses, and protects information when Sponsors, Contributors, Validators, operators, and visitors use the Community website, dashboard, admin console, and API.
        </p>
        <p className="mt-5 font-mono text-xs text-dark-dim">Last updated: {UPDATED}</p>

        <Section title="1. Who We Are">
          <p>
            DataBounty is operated by [X]CUBE LABS PTE. LTD., Singapore. &ldquo;DataBounty,&rdquo; &ldquo;we,&rdquo; &ldquo;us,&rdquo; and &ldquo;our&rdquo; mean [X]CUBE LABS PTE. LTD., Singapore and the Community service we provide under the DataBounty name.
          </p>
        </Section>

        <Section title="2. Information We Collect">
          <p>
            We collect information you provide directly, including account
            details, profile information, email address, role selections,
            Community request details, submissions, review notes, and support
            messages.
          </p>
          <p>
            If you connect third-party accounts, such as Google sign-in or other
            profile-source integrations, we collect information authorized by
            you through that provider, such as account identifiers, email
            address, name, avatar, and basic profile metadata.
          </p>
          <p>
            We also collect technical and usage data, including IP address,
            device and browser information, pages viewed, actions taken,
            timestamps, authentication events, API logs, security logs, cookie
            identifiers, and validation or execution metadata.
          </p>
        </Section>

        <Section title="3. Requests, Submissions, and Validation Data">
          <p>
            DataBounty Community processes Community request details, dataset
            items, attachments, test cases, validation logs, review decisions,
            duplicate-detection signals, sandbox execution results, and
            quality-review outputs to operate the platform.
          </p>
          <p>
            Some request, dataset, quality, delivery, and recognition
            information may be visible to Sponsors, Contributors, Validators,
            administrators, or public visitors depending on the request&apos;s
            status, role permissions, license terms, and product feature.
          </p>
        </Section>

        <Section title="4. How We Use Information">
          <p>
            We use information to provide, secure, maintain, and improve
            DataBounty Community; authenticate users; enable Sponsor,
            Contributor, and Validator workflows; process requests, submissions,
            and reviews; prevent fraud and abuse; enforce platform rules; comply
            with legal obligations; and communicate service, security, product,
            and support updates.
          </p>
          <p>
            We may use aggregated or de-identified information to understand
            platform performance, improve validation quality, debug product
            issues, and publish non-identifying platform statistics.
          </p>
        </Section>

        <Section title="5. Cookies and Similar Technologies">
          <p>
            We use cookies, local storage, and similar technologies for
            authentication, security, session management, preferences,
            analytics, diagnostics, and product operations. You can control
            cookies through your browser settings, but disabling some cookies
            may affect sign-in or core platform functionality.
          </p>
        </Section>

        <Section title="6. How We Share Information">
          <p>
            We share information with service providers and infrastructure
            vendors that help us run DataBounty Community, including cloud
            hosting, storage, database, analytics, email, authentication,
            validation, sandbox execution, compliance, and support providers.
          </p>
          <p>
            We may share information with other users as necessary to operate
            Community workflows (for example, showing a Sponsor who submitted an
            item under their request), with law enforcement or regulators when
            required, to protect rights and safety, or as part of a merger,
            acquisition, financing, reorganization, or sale of assets.
          </p>
        </Section>

        <Section title="7. Data Retention">
          <p>
            We keep information for as long as needed to provide DataBounty
            Community, comply with legal and accounting obligations, resolve
            disputes, enforce agreements, maintain security, support audits, and
            preserve platform integrity. Retention periods vary based on the
            type of data and the reason it is processed.
          </p>
        </Section>

        <Section title="8. Security">
          <p>
            We use administrative, technical, and organizational safeguards
            designed to protect information. No system is perfectly secure, and
            we cannot guarantee that unauthorized access, loss, misuse, or
            alteration will never occur.
          </p>
        </Section>

        <Section title="9. Your Choices">
          <p>
            Depending on your location and applicable law, you may have rights to
            access, correct, delete, export, restrict, or object to certain
            processing of your personal information. You may also disconnect
            third-party sign-in integrations or contact support for help with
            your account.
          </p>
          <p>
            Some information may be retained where required for security, fraud
            prevention, legal compliance, dispute resolution, audit integrity, or
            legitimate platform operations.
          </p>
        </Section>

        <Section title="10. Children">
          <p>
            DataBounty Community is not intended for children under 13, and we do not knowingly collect personal information from children under 13.
          </p>
        </Section>

        <Section title="11. Changes to This Policy">
          <p>
            We may update this Privacy Policy from time to time. If we make
            material changes, we will update the date above and may provide
            additional notice through the service or other reasonable means.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions about this Privacy Policy can be sent through DataBounty support channels. You can also review our{" "}
            <Link href="/terms" className="text-lime hover:underline">
              Terms of Service
            </Link>
            .
          </p>
        </Section>
      </section>
    </main>
  );
}
