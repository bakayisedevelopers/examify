import { useNavigate } from 'react-router-dom';
import { LEGAL_POLICY_EFFECTIVE_DATE } from '../lib/legalPolicyVersion';

const PolicySection = ({ id, title, children }) => (
  <section id={id} className="scroll-mt-6 space-y-4">
    <h2 className="text-2xl font-bold text-slate-950">{title}</h2>
    {children}
  </section>
);

const PolicyList = ({ items }) => (
  <ul className="list-disc space-y-2 pl-5 text-slate-600">
    {items.map((item) => <li key={item}>{item}</li>)}
  </ul>
);

const externalLinkClass = 'font-semibold text-lime-700 underline underline-offset-2 hover:text-lime-800';

export const PoliciesPage = () => {
  const navigate = useNavigate();
  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="mx-auto min-h-screen max-w-4xl scroll-smooth px-4 py-12 lg:px-6">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="mb-6 text-sm font-semibold text-lime-400 hover:text-lime-300 hover:underline"
      >
        ← Back
      </button>

      <header className="mb-10">
        <h1 className="text-4xl font-bold text-white">Examifying Terms & Privacy</h1>
        <p className="mt-3 text-slate-400">
          Terms of Use, Refund & Cancellation Policy, and Privacy Policy. Effective {LEGAL_POLICY_EFFECTIVE_DATE}.
        </p>
      </header>

      <div className="panel space-y-10 p-6">
        <nav aria-label="Legal policy sections" className="flex flex-wrap gap-4 text-sm font-medium">
          <button type="button" onClick={() => scrollToSection('terms')} className="font-semibold text-lime-700 hover:underline">Terms of Use</button>
          <button type="button" onClick={() => scrollToSection('refunds')} className="font-semibold text-lime-700 hover:underline">Refund & Cancellation</button>
          <button type="button" onClick={() => scrollToSection('privacy')} className="font-semibold text-lime-700 hover:underline">Privacy Policy</button>
          <button type="button" onClick={() => scrollToSection('contact')} className="font-semibold text-lime-700 hover:underline">Contact</button>
        </nav>

        <PolicySection id="terms" title="Terms of Use">
          <p className="text-slate-600">
            These terms apply when you access Examifying’s website or app. Examifying provides Mathematics learning tools,
            exercise generation, past-paper resources, student and tutor workspaces, lesson scheduling, peer marking,
            progress records, and subscription services. By creating an account or using the service, you agree to these
            terms and acknowledge the Privacy Policy. If you do not agree, do not create or use an account.
          </p>

          <h3 className="font-semibold text-slate-900">1. Accounts, roles, and student users</h3>
          <p className="text-slate-600">
            Users must provide accurate account details, keep their passwords private, and promptly correct information
            that changes. Accounts may be used as a student, parent, tutor, teacher, or administrator. Parents may link
            student accounts; tutors and teachers may access the students and subjects assigned to them; administrators
            may access information needed to operate and protect the service.
          </p>
          <p className="text-slate-600">
            A person under 18 is a child for POPIA purposes. A student under 18 may use Examifying only after a parent,
            legal guardian, or other competent person has reviewed these terms and the Privacy Policy and given the prior
            consent required by law. A parent or guardian who creates or links a student account confirms they have
            authority to act for that child. Contact us if consent is withdrawn or an account was created without the
            required permission.
          </p>

          <h3 className="font-semibold text-slate-900">2. Learning features, AI, and peer marking</h3>
          <p className="text-slate-600">
            Exercise recommendations and paper analysis may use automated tools and AI models. They support learning and
            are not formal school marks, admissions decisions, or professional advice. AI can make mistakes; students,
            parents, and tutors should review outputs and report errors. Tutors remain responsible for their professional
            feedback and recorded lesson or marking scores.
          </p>
          <p className="text-slate-600">
            When peer marking is used, an assigned student reviewer may see the exercise questions and submitted answer
            images needed to mark that work. Do not write passwords, identity numbers, or unrelated personal information
            on an answer page. Use the platform respectfully and do not copy, download, redistribute, or misuse another
            user’s work or information.
          </p>

          <h3 className="font-semibold text-slate-900">3. Subscriptions and payments</h3>
          <p className="text-slate-600">
            Circle provides group-learning benefits and Personalized provides one-on-one and group-learning benefits,
            subject to the plan, subject count, and lesson entitlements shown at checkout. The current price, billing
            period, applicable discount, and amount due are shown before payment. Discount codes are subject to their
            stated plan, account, date, and redemption limits. A code does not change an existing payment or subscription
            retroactively.
          </p>
          <p className="text-slate-600">
            Paystack processes payments. Where a reusable payment authorization is granted, Examifying may use the
            authorization to process subscription renewals. Manage or cancel renewal through the subscription controls
            shown in your account. A cancellation ordinarily stops future renewals while access continues to the end of
            the paid period, unless the checkout or applicable law provides otherwise. Nothing in these terms removes a
            right that cannot lawfully be excluded.
          </p>

          <h3 className="font-semibold text-slate-900">4. User content and acceptable use</h3>
          <p className="text-slate-600">
            You keep your rights in material you submit. You give Examifying permission to store, display, and process it
            only as needed to provide the features you use, including sharing relevant work with your assigned tutor,
            linked parent, or allocated peer reviewer and processing documents for requested analysis. Upload only
            material you have the right to use, and avoid including another person’s personal information unless you are
            authorised to do so.
          </p>
          <PolicyList items={[
            'Do not access another account, attempt to bypass permissions, or interfere with service security.',
            'Do not harass, exploit, impersonate, or endanger another user, especially a student.',
            'Do not use the service for unlawful activity or upload harmful, misleading, or unauthorised material.',
            'Tutors, teachers, parents, and administrators must protect student information and use it only for the assigned educational or service purpose.',
          ]} />

          <h3 className="font-semibold text-slate-900">5. Availability, suspension, and changes</h3>
          <p className="text-slate-600">
            We may maintain, change, or temporarily suspend features for security, operational, or legal reasons. We may
            restrict an account where there is a reasonable security, safety, payment, or terms concern, and will handle
            the matter in accordance with applicable law. We may update these terms and will show the effective date of
            the latest version. Material changes will be communicated through the service or another suitable channel.
          </p>

          <h3 className="font-semibold text-slate-900">6. South African law</h3>
          <p className="text-slate-600">
            These terms are governed by South African law. Any limitation or exclusion in these terms applies only to the
            extent permitted by law and does not limit rights that cannot be excluded.
          </p>
        </PolicySection>

        <PolicySection id="refunds" title="Refund & Cancellation Policy">
          <p className="text-slate-600">
            You can manage renewal and cancellation in the subscription area of your account. Cancellation stops future
            recurring charges when it takes effect; it does not automatically reverse a payment already processed or
            refund unused time. We will review duplicate, incorrect, or unsuccessful-payment cases and any refund request
            under the applicable checkout terms and consumer law. If a payment succeeded but the subscription did not
            activate, contact us with the payment reference. Statutory rights are not limited by this policy.
          </p>
        </PolicySection>

        <PolicySection id="privacy" title="Privacy Policy">
          <p className="text-slate-600">
            This notice explains how Examifying collects, uses, stores, and shares personal information under the
            Protection of Personal Information Act 4 of 2013 (POPIA). Examifying is the responsible party for the
            information it determines the purposes and means of processing. The privacy contact is
            {' '}<a className={externalLinkClass} href="mailto:bakayise.developers@gmail.com">bakayise.developers@gmail.com</a>.
          </p>

          <h3 className="font-semibold text-slate-900">1. Information we process</h3>
          <PolicyList items={[
            'Account and contact details: name, email address, Firebase account identifier, account role, school, grade, province, and (for student accounts) WhatsApp number.',
            'Education and tutoring records: subjects, topics, marks, understanding scores, completed lessons, schedules, attendance, tutor notes and reports, exercise history, marking activity, and progress records.',
            'Content and files: question-paper PDFs and extracted indexes, student answer images, tutor marks documents or proof, and text or images submitted for OCR, analysis, marking, or support.',
            'Parent, tutor, and staff relationships: linked parent/student accounts, tutor assignments, access history needed to manage those relationships, and tutor agreement details.',
            'Subscription and payment records: selected plan, subject count, amount, discount, billing and renewal dates, transaction references and status, and Paystack authorization details returned for recurring payments. Examifying does not receive or store a full card number or card security code, but it stores the reusable authorization token and limited card metadata such as last four digits, expiry, card type, and bank when Paystack provides them.',
            'Notification preferences: your in-app and email choices by notification type, plus your separate optional marketing email opt-in.',
            'Device and service data: browser and user-agent details, push-notification token and permission state, timestamps, operational logs, and technical information processed by Firebase or other service providers.',
          ]} />
          <p className="text-slate-600">
            We receive information from you, a parent or guardian who links an account, an assigned tutor or teacher, an
            administrator managing the service, and providers that confirm sign-in or payment events. Please provide
            accurate information and avoid uploading personal information that is not needed for the learning task.
          </p>

          <h3 className="font-semibold text-slate-900">2. Why we use it and lawful grounds</h3>
          <PolicyList items={[
            'Create and secure accounts, confirm roles, link parents and students, and provide the requested learning and tutoring service.',
            'Schedule lessons, assign exercises and peer-marking work, record results, and show educational progress to the student and authorised linked parent, tutor, teacher, or administrator.',
            'Process subscriptions and payments, verify transactions, prevent fraud, manage renewals, and keep records required for accounting or legal claims.',
            'Run document extraction, past-paper analysis, topic resolution, exercise recommendations, and answer-image review requested as part of the service.',
            'Protect the service, investigate misuse, provide support, and maintain reliability.',
          ]} />
          <p className="text-slate-600">
            Depending on the activity, POPIA grounds may include performing the service agreement, complying with a legal
            obligation, consent, or a legitimate interest that does not override the data subject’s rights. Where the
            information relates to a child, we process it only under an applicable section 35 basis, including prior
            consent from a competent person where required. Consent may be withdrawn; withdrawal does not undo processing
            already lawfully completed or processing that has another lawful ground.
          </p>

          <h3 className="font-semibold text-slate-900">3. AI and automated processing</h3>
          <p className="text-slate-600">
            Depending on the feature, AI requests may include question-paper pages, marks documents, submitted answer
            images, grade and subject, completed topics, understanding-score history, lesson history, tutor reports or
            notes, analyzed paper indexes, and prior exercise history. These inputs are used to extract academic
            information or produce exercise and topic suggestions. We do not intend to send account passwords or payment
            card numbers to AI models, but a document or free-text note you upload may itself contain identifying details.
            AI outputs may be inaccurate and should be reviewed by a tutor or user; they are not used as a substitute for
            formal school assessment. You may ask us to review a significant outcome that you believe is wrong.
          </p>
          <p className="text-slate-600">
            AI processing currently uses Google Gemini and the configured Kilo model API. Their processing, retention,
            and location may depend on the particular service configuration and provider terms. Please do not upload
            confidential information that is not needed for the requested feature.
          </p>

          <h3 className="font-semibold text-slate-900">4. Who may receive information</h3>
          <PolicyList items={[
            'A student’s linked parent or guardian, assigned tutor or teacher, and authorised Examifying administrators may see records needed for their role.',
            'An allocated peer reviewer may see the exercise and answer pages needed to complete peer marking.',
            'Google Firebase services provide authentication, database, file storage, hosting, backend functions, and push notifications.',
            'Resend delivers account, payment, tutor-assignment, and successful exercise-generation emails. It receives the recipient email address and the message details needed to deliver each notification. Discount-offer emails are sent only when the recipient has opted in to marketing email.',
            'Paystack receives the information needed to initiate and verify payments and provide recurring-payment authorizations.',
            'Google Gemini and the configured Kilo AI service receive feature inputs when an AI feature is used.',
            'We may disclose information if required by law, to protect users or the service, or to establish or defend legal rights.',
          ]} />
          <p className="text-slate-600">We do not sell personal information.</p>

          <h3 className="font-semibold text-slate-900">5. Storage outside South Africa</h3>
          <p className="text-slate-600">
            The current Firebase project is configured to store Firestore data in Google Cloud’s us-central1 region in
            the United States. Firebase, Resend, Paystack, and AI providers may process information in other countries according
            to their service configuration. Before or while making a cross-border transfer, Examifying must rely on a
            condition in POPIA section 72 and put the required protection in place. Contact the privacy address above to
            ask about a particular transfer or provider.
          </p>

          <h3 className="font-semibold text-slate-900">6. Retention and account deletion</h3>
          <p className="text-slate-600">
            We keep information for as long as it is needed to provide the service, maintain learning and payment
            records, meet legal obligations, resolve disputes, and protect users. Retention periods depend on the record
            and purpose; provider backups and logs may follow their own deletion cycles. When information is no longer
            lawfully needed, it should be securely deleted, destroyed, or de-identified.
          </p>
          <p className="text-slate-600">
            The current in-app account deletion control removes the Firebase sign-in account and top-level profile, but
            does not automatically cascade through every nested learning, assignment, payment, notification, or uploaded
            file record. To request access to, correction of, or deletion of related records, email the privacy contact.
            We will verify the requester and handle the request under POPIA, including any lawful retention requirement.
          </p>

          <h3 className="font-semibold text-slate-900">7. Security and security compromises</h3>
          <p className="text-slate-600">
            We use access controls and reasonable technical and organisational safeguards suited to the service. No online
            service can guarantee absolute security. If there are reasonable grounds to believe personal information was
            accessed or acquired by an unauthorised person, we will notify the Information Regulator and affected data
            subjects as soon as reasonably possible as required by POPIA.
          </p>

          <h3 className="font-semibold text-slate-900">8. Your rights and how to use them</h3>
          <p className="text-slate-600">
            Subject to POPIA and other applicable law, you may ask whether we hold your personal information, request
            access to it, ask us to correct or delete inaccurate or unlawfully held information, object to certain
            processing, withdraw consent, and complain to the Information Regulator. A parent or competent person may
            make a request for a child where legally authorised. Email
            {' '}<a className={externalLinkClass} href="mailto:bakayise.developers@gmail.com?subject=Examifying%20privacy%20request">bakayise.developers@gmail.com</a>
            {' '}with “Examifying privacy request” in the subject, the account email, the request you want to make, and
            (for a child) evidence that you may act for them. Do not send your password. We may ask for reasonable proof
            of identity or authority before releasing records.
          </p>
          <p className="text-slate-600">
            You may also lodge a complaint with the
            {' '}<a className={externalLinkClass} href="https://inforegulator.org.za/contact-us/" target="_blank" rel="noreferrer">Information Regulator (South Africa)</a>
            {' '}or email <a className={externalLinkClass} href="mailto:POPIAComplaints@inforegulator.org.za">POPIAComplaints@inforegulator.org.za</a>.
          </p>

          <h3 className="font-semibold text-slate-900">9. Browser storage, cookies, and notifications</h3>
          <p className="text-slate-600">
            Examifying does not currently set first-party browser cookies or use analytics or advertising trackers. Firebase
            Authentication uses necessary browser storage, such as IndexedDB or local storage where supported, to keep you
            signed in and complete authentication securely. Examifying also stores your cookie preference on this device so
            the consent prompt does not appear on every visit. These necessary functions cannot be disabled in the app.
            Google sign-in and Paystack checkout use provider-hosted flows; any storage or cookies used on Google or
            Paystack domains are governed by those providers' own privacy information.
          </p>
          <p className="text-slate-600">
            If you enable browser notifications, the browser and Firebase Cloud Messaging create a device token that we
            store to deliver service notifications. You can revoke notification permission in your browser or device
            settings. The app currently has no optional analytics or advertising storage categories. Use the Cookie
            Preferences control available throughout Examifying to review or change the saved choice; for signed-in users,
            the preference is also recorded on their account.
          </p>

          <h3 className="font-semibold text-slate-900">10. Marketing and service messages</h3>
          <p className="text-slate-600">
            We send account, payment, assignment, and successful exercise-generation messages needed to operate the
            service according to the channel preferences in Settings. We do not treat notification permission or a
            service-message preference as consent to direct marketing. Discount offers and product updates are sent by
            email only when you actively opt in during account creation or in Settings; you can withdraw that choice
            there. We will send direct marketing by electronic communication only where POPIA permits it.
          </p>

          <h3 className="font-semibold text-slate-900">11. Changes to this notice</h3>
          <p className="text-slate-600">
            We may update this policy as the service or law changes. The effective date at the top will change when a new
            version is published. We will provide additional notice or request renewed consent where required.
          </p>

          <p className="text-sm text-slate-500">
            Read the <a className={externalLinkClass} href="https://www.justice.gov.za/legislation/acts/2013-004.pdf" target="_blank" rel="noreferrer">Protection of Personal Information Act</a>,
            {' '}<a className={externalLinkClass} href="https://firebase.google.com/support/privacy/" target="_blank" rel="noreferrer">Firebase privacy information</a>,
            {' '}<a className={externalLinkClass} href="https://paystack.com/za/terms" target="_blank" rel="noreferrer">Paystack terms and privacy information</a>, and
            {' '}<a className={externalLinkClass} href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noreferrer">Gemini API terms</a>.
          </p>
        </PolicySection>

        <PolicySection id="contact" title="Contact Information">
          <div className="space-y-2 text-slate-700">
            <p><strong>Service:</strong> Examifying</p>
            <p><strong>Country:</strong> South Africa</p>
            <p><strong>Privacy requests and enquiries:</strong> <a className={externalLinkClass} href="mailto:bakayise.developers@gmail.com">bakayise.developers@gmail.com</a></p>
            <p><strong>Information Regulator:</strong> <a className={externalLinkClass} href="https://inforegulator.org.za/contact-us/" target="_blank" rel="noreferrer">inforegulator.org.za/contact-us</a></p>
          </div>
        </PolicySection>
      </div>
    </main>
  );
};
