import { useNavigate } from 'react-router-dom';

export const PoliciesPage = () => {
  const navigate = useNavigate();
  const scrollToSection = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <main className="mx-auto min-h-screen max-w-4xl px-4 py-12 lg:px-6 scroll-smooth">
      
      {/* 🔙 BACK BUTTON */}
      <button
        onClick={() => navigate(-1)}
        className="mb-6 text-sm font-semibold text-lime-400 hover:text-lime-300 hover:underline"
      >
        ← Back
      </button>

      {/* HEADER */}
      <div className="mb-10">
        <h1 className="text-4xl font-bold text-white">Examifying Policies</h1>
        <p className="mt-3 text-slate-400">
          Please review our terms, policies, and conditions before using Examifying.
        </p>
      </div>

      <div className="panel p-6 space-y-10">

        {/* NAV */}
        <div className="flex flex-wrap gap-4 text-sm font-medium">
          <button type="button" onClick={() => scrollToSection('terms')} className="text-lime-400 hover:text-lime-300 hover:underline font-semibold">Terms of Service</button>
          <button type="button" onClick={() => scrollToSection('refunds')} className="text-lime-400 hover:text-lime-300 hover:underline font-semibold">Refund & Cancellation</button>
          <button type="button" onClick={() => scrollToSection('privacy')} className="text-lime-400 hover:text-lime-300 hover:underline font-semibold">Privacy Policy</button>
          <button type="button" onClick={() => scrollToSection('contact')} className="text-lime-400 hover:text-lime-300 hover:underline font-semibold">Contact Info</button>
        </div>

        {/* ================= TERMS ================= */}
        <section id="terms" className="space-y-4">
          <h2 className="text-2xl font-bold text-slate-950">Terms of Service</h2>

          <p className="text-slate-600">
            By accessing or using Examifying, you agree to these Terms of Service.
            Examifying is an educational platform supporting students, tutors, and administrators
            with academic tools, session management, and performance tracking.
          </p>

          <h3 className="font-semibold text-slate-900">1. User Roles</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li><strong>Students:</strong> Access learning recommendations and tutoring services.</li>
            <li><strong>Tutors:</strong> Provide academic support, reports, and session guidance.</li>
            <li><strong>Admins:</strong> Manage platform operations, users, and system integrity.</li>
          </ul>

          <h3 className="font-semibold text-slate-900">2. Eligibility</h3>
          <p className="text-slate-600">
            Users must be at least 13 years old. Users under 18 require parental or guardian consent.
          </p>

          <h3 className="font-semibold text-slate-900">3. General User Responsibilities</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Provide accurate and up-to-date information.</li>
            <li>Maintain confidentiality of account credentials.</li>
            <li>Use the platform only for lawful educational purposes.</li>
          </ul>

          <h3 className="font-semibold text-slate-900">4. Student Responsibilities</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Provide accurate academic performance data.</li>
            <li>Engage respectfully with tutors and the platform.</li>
            <li>Use recommendations responsibly for learning purposes.</li>
          </ul>

          <h3 className="font-semibold text-slate-900">5. Tutor Responsibilities</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Provide accurate and professional academic support.</li>
            <li>Submit honest and constructive tutor reports.</li>
            <li>Maintain respectful and ethical conduct with students.</li>
            <li>Do not misuse student data or platform tools.</li>
          </ul>

          <h3 className="font-semibold text-slate-900">6. Admin अधिकार & Responsibilities</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Admins may monitor and manage platform usage.</li>
            <li>Admins may suspend or remove accounts violating policies.</li>
            <li>Admins ensure system security and data integrity.</li>
          </ul>

          <h3 className="font-semibold text-slate-900">7. Acceptable Use</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>No unlawful, abusive, or harmful activity.</li>
            <li>No unauthorized access or system exploitation.</li>
            <li>No impersonation or misuse of roles.</li>
          </ul>

          <h3 className="font-semibold text-slate-900">8. Educational Disclaimer</h3>
          <p className="text-slate-600">
            Examifying provides academic support tools and recommendations but does not guarantee
            academic performance improvements.
          </p>

          <h3 className="font-semibold text-slate-900">9. Payments</h3>
          <p className="text-slate-600">
            Payments are processed via third-party providers such as Paystack. Examifying does not
            store sensitive payment details.
          </p>

          <h3 className="font-semibold text-slate-900">10. Account Termination</h3>
          <p className="text-slate-600">
            We reserve the right to suspend or terminate any account that violates these terms.
          </p>

          <h3 className="font-semibold text-slate-900">11. Limitation of Liability</h3>
          <p className="text-slate-600">
            Examifying is not liable for any indirect or consequential damages arising from use of the platform.
          </p>
        </section>

        {/* ================= REFUNDS ================= */}
        <section id="refunds" className="space-y-4">
          <h2 className="text-2xl font-bold text-slate-950">Refund & Cancellation Policy</h2>

          <p className="text-slate-600">
            Examifying operates on a subscription-based billing model.
          </p>

          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Subscriptions renew automatically unless cancelled before renewal.</li>
            <li>Students may cancel anytime via their profile.</li>
            <li>Access remains until the end of the billing cycle.</li>
            <li>No refunds for partially used billing periods.</li>
            <li>Refunds only for duplicate or incorrect charges.</li>
          </ul>
        </section>

        {/* ================= PRIVACY ================= */}
        <section id="privacy" className="space-y-4">
          <h2 className="text-2xl font-bold text-slate-950">Privacy Policy</h2>

          <h3 className="font-semibold text-slate-900">1. Data We Collect</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Personal info (name, email)</li>
            <li>Academic data (grades, marks, reports)</li>
            <li>Usage/activity data</li>
            <li>Tutor-generated reports and feedback</li>
          </ul>

          <h3 className="font-semibold text-slate-900">2. How Data Is Used</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Personalising recommendations</li>
            <li>Improving platform performance</li>
            <li>Supporting tutors and admin decisions</li>
            <li>Providing customer support</li>
          </ul>

          <h3 className="font-semibold text-slate-900">3. Data Sharing</h3>
          <p className="text-slate-600">
            Data is not sold. It is only shared with essential providers such as Paystack for payments.
          </p>

          <h3 className="font-semibold text-slate-900">4. Security</h3>
          <p className="text-slate-600">
            We implement safeguards to protect user data, but cannot guarantee absolute security.
          </p>

          <h3 className="font-semibold text-slate-900">5. User Rights</h3>
          <ul className="list-disc pl-5 space-y-2 text-slate-600">
            <li>Access your data</li>
            <li>Request corrections</li>
            <li>Request deletion</li>
          </ul>
        </section>

        {/* ================= CONTACT ================= */}
        <section id="contact" className="space-y-4">
          <h2 className="text-2xl font-bold text-slate-950">Contact Information</h2>

          <div className="space-y-2 text-slate-700">
            <p><strong>Email:</strong> bakayise.developers@gmail.com</p>
            <p><strong>Business Name:</strong> Examifying</p>
            <p><strong>Country:</strong> South Africa</p>
          </div>
        </section>

      </div>
    </main>
  );
};
