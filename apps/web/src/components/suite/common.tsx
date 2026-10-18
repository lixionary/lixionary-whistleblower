"use client";
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { BuildSignature } from "@/components/build-signature";
import { LanguageSelector } from "./language-selector";
import { api, ApiError } from "@/lib/api";
export const strings = {
  developmentTracker: ["Development Tracker", "Pelacak Pengembangan"],
  jiraIntro: [
    "Report software errors, request features, and follow development in LWB on Lixionary Jira.",
    "Laporkan kesalahan aplikasi, ajukan fitur, dan ikuti pengembangan LWB di Lixionary Jira.",
  ],
  jiraPrivacy: [
    "Use this page for application feedback. Exclude confidential case details and employee information from reports and attachments.",
    "Gunakan halaman ini untuk masukan aplikasi. Jangan sertakan detail kasus rahasia atau informasi karyawan dalam laporan dan lampiran.",
  ],
  refreshBoard: ["Refresh board", "Muat ulang papan"],
  jiraReportActions: ["Report to Jira", "Laporkan ke Jira"],
  jiraReportError: ["Report an error", "Laporkan kesalahan"],
  jiraRequestFeature: ["Request a feature", "Ajukan fitur"],
  jiraOpening: ["Opening Jira…", "Membuka Jira…"],
  jiraPopupBlocked: [
    "Allow pop-ups for this site, then try again.",
    "Izinkan pop-up untuk situs ini, lalu coba lagi.",
  ],
  jiraSubmitted: ["Submitted to Jira:", "Dikirim ke Jira:"],
  jiraDisabled: [
    "The development tracker is not configured yet.",
    "Pelacak pengembangan belum dikonfigurasi.",
  ],
  jiraBoard: ["LWB development board", "Papan pengembangan LWB"],
  jira_pending: ["Pending", "Menunggu"],
  jira_todo: ["To do", "Akan dikerjakan"],
  jira_in_progress: ["In progress", "Sedang dikerjakan"],
  jira_pending_release: ["Pending release", "Menunggu rilis"],
  jira_closed: ["Closed", "Ditutup"],
  jiraIssue: ["Error report", "Laporan kesalahan"],
  jiraFeature: ["Feature request", "Permintaan fitur"],
  jiraDone: ["Done", "Selesai"],
  jiraRejected: ["Rejected", "Ditolak"],
  jiraEmpty: ["No tickets here.", "Belum ada tiket."],
  jiraLoadMore: ["Load more", "Muat lainnya"],
  skip: ["Skip to content", "Langsung ke konten"],
  navigation: ["Main navigation", "Navigasi utama"],
  confidential: ["Confidential reporting", "Pelaporan rahasia"],
  noAccount: ["No account required", "Tidak perlu akun"],
  reportIntro: [
    "Share a concern at your own pace. Review your report and evidence before sharing them with the review team.",
    "Sampaikan kekhawatiran Anda sesuai kenyamanan Anda. Tinjau laporan dan bukti sebelum membagikannya kepada tim peninjau.",
  ],
  caseIntro: [
    "Use your saved case code and access secret to follow progress and speak privately with your review team.",
    "Gunakan kode laporan dan rahasia akses yang tersimpan untuk mengikuti perkembangan dan berbicara secara pribadi dengan tim peninjau.",
  ],
  staffAccess: ["Staff access", "Akses staf"],
  googleLogin: ["Sign in with Google", "Masuk dengan Google"],
  staffIntro: [
    "Sign in with your staff account. An authenticator or recovery code is required to continue.",
    "Masuk dengan akun staf Anda. Kode autentikator atau pemulihan diperlukan untuk melanjutkan.",
  ],
  previousPage: ["Previous page", "Halaman sebelumnya"],
  nextPage: ["Next page", "Halaman berikutnya"],
  what: ["More detail about what happened", "Detail tentang kejadian"],
  high: ["High", "Tinggi"],
  critical: ["Critical", "Kritis"],
  who: ["Who was involved?", "Siapa yang terlibat?"],
  when: ["When did it happen?", "Kapan kejadian terjadi?"],
  where: ["Where did it happen?", "Di mana kejadian terjadi?"],
  why: ["Why did it happen, if known?", "Mengapa terjadi, jika diketahui?"],
  how: ["How did it happen?", "Bagaimana kejadiannya?"],
  howKnown: ["How do you know?", "Bagaimana Anda mengetahuinya?"],
  impact: ["Impact or harm", "Dampak atau kerugian"],
  ongoing: ["Is it ongoing?", "Apakah masih berlangsung?"],
  home: ["Confidential reporting", "Pelaporan rahasia"],
  report: ["Create a report", "Buat laporan"],
  portal: ["Open my case", "Buka laporan saya"],
  staff: ["Staff portal", "Portal staf"],
  privacy: [
    "Reports are submitted confidentially and can be completely anonymous. Optional case contacts are hidden from review staff; report details may still identify you.",
    "Laporan dikirim secara rahasia dan dapat sepenuhnya anonim. Kontak laporan opsional disembunyikan dari staf peninjau; isi laporan dapat mengungkapkan identitas Anda.",
  ],
  reporterEmail: [
    "Notification email (optional)",
    "Email notifikasi (opsional)",
  ],
  reporterEmailHint: [
    "Optional. Used only to send you case update alerts. Kept confidential and hidden from case handlers.",
    "Opsional. Hanya digunakan untuk mengirim pemberitahuan pembaruan laporan. Dijaga kerahasiaannya dan disembunyikan dari peninjau laporan.",
  ],
  verifyEmailNotification: [
    "Verify notification email",
    "Verifikasi email notifikasi",
  ],
  verifyEmailNotificationDesc: [
    "A 6-digit verification code was queued for %s. Enter it below to activate notifications, or continue now and verify later in your case portal.",
    "Kode verifikasi 6-digit telah dikirim ke %s. Masukkan di bawah untuk mengaktifkan notifikasi, atau lanjutkan sekarang dan verifikasi nanti di portal laporan Anda.",
  ],
  emailVerifiedSuccess: [
    "Notification email verified successfully.",
    "Email notifikasi berhasil diverifikasi.",
  ],
  submit: ["Submit report", "Kirim laporan"],
  save: ["Save", "Simpan"],
  cancel: ["Cancel", "Batal"],
  signout: ["Sign out", "Keluar"],
  send: ["Send", "Kirim"],
  body: ["Message", "Pesan"],
  caseCode: ["Case code", "Kode laporan"],
  pin: ["Access secret", "Rahasia akses"],
  recovery: ["Recovery secret", "Rahasia pemulihan"],
  title: ["Title", "Judul"],
  summary: ["What happened?", "Apa yang terjadi?"],
  category: ["Category", "Kategori"],
  businessUnit: ["Business unit", "Unit bisnis"],
  sensitive: [
    "This concerns leadership or the usual review team. Use the independent review team.",
    "Laporan ini terkait pimpinan atau tim peninjau biasa. Gunakan tim peninjau independen.",
  ],
  policy: ["Reporting policy", "Kebijakan pelaporan"],
  notice: ["Privacy notice", "Pemberitahuan privasi"],
  review: [
    "I reviewed this content and removed details that could identify me.",
    "Saya telah meninjau isi ini dan menghapus detail yang dapat mengidentifikasi saya.",
  ],
  error: [
    "Unable to complete this request.",
    "Permintaan ini belum dapat diselesaikan.",
  ],
  loading: ["Loading…", "Memuat…"],
  verified: ["Contact verified", "Kontak terverifikasi"],
  verifyMeaning: [
    "Verification confirms control of your contact, not your legal identity. Staff see only verification status.",
    "Verifikasi memastikan kendali atas kontak Anda, bukan identitas hukum Anda. Staf hanya melihat status verifikasi.",
  ],
  contacts: ["Optional private contacts", "Kontak pribadi opsional"],
  destination: [
    "Email address or international phone number",
    "Alamat email atau nomor telepon internasional",
  ],
  notifications: [
    "Send generic notifications to this contact",
    "Kirim notifikasi umum ke kontak ini",
  ],
  otp: ["Send verification code", "Kirim kode verifikasi"],
  code: ["Verification code", "Kode verifikasi"],
  verify: ["Verify", "Verifikasi"],
  delete: ["Delete", "Hapus"],
  files: ["Evidence", "Bukti"],
  upload: ["Upload for processing", "Unggah untuk diproses"],
  preview: ["View sanitized preview", "Lihat pratinjau yang disanitasi"],
  approve: [
    "Approve and share with reviewers",
    "Setujui dan bagikan dengan peninjau",
  ],
  redact: ["Apply permanent redactions", "Terapkan penyamaran permanen"],
  page: ["Page", "Halaman"],
  messages: ["Private conversation", "Percakapan pribadi"],
  reopen: ["Request reopening", "Minta dibuka kembali"],
  reason: ["Reason", "Alasan"],
  rotate: ["Replace saved access secrets", "Ganti rahasia akses tersimpan"],
  receipt: [
    "Save these secrets somewhere private. They are shown once. Contact verification cannot recover your case.",
    "Simpan rahasia ini di tempat pribadi. Rahasia hanya ditampilkan sekali. Verifikasi kontak tidak dapat memulihkan laporan.",
  ],
  saved: ["I have saved my secrets", "Saya telah menyimpan rahasia saya"],
  password: ["Password", "Kata sandi"],
  email: ["Email", "Email"],
  login: ["Sign in", "Masuk"],
  authenticator: [
    "Authenticator or recovery code",
    "Kode autentikator atau pemulihan",
  ],
  enroll: [
    "Scan this QR code with your authenticator app, then enter its six-digit code. You can also enter the setup key manually or open the app on this device.",
    "Pindai kode QR ini dengan aplikasi autentikator, lalu masukkan kode enam digitnya. Anda juga dapat memasukkan kunci penyiapan secara manual atau membuka aplikasi di perangkat ini.",
  ],
  mfaQr: ["Authenticator setup QR code", "Kode QR penyiapan autentikator"],
  setupKey: ["Manual setup key", "Kunci penyiapan manual"],
  recover: ["Recover with saved secret", "Pulihkan dengan rahasia tersimpan"],
  newPassword: [
    "New password (at least 15 characters)",
    "Kata sandi baru (minimal 15 karakter)",
  ],
  reset: ["Send password reset link", "Kirim tautan pengaturan kata sandi"],
  name: ["Name", "Nama"],
  role: ["Role", "Peran"],
  active: ["Active", "Aktif"],
  assign: ["Assign reviewer", "Tetapkan peninjau"],
  owner: ["Primary investigator", "Penyelidik utama"],
  state: ["Status", "Status"],
  recuse: ["Recuse myself", "Mengundurkan diri dari kasus"],
  notes: ["Internal notes", "Catatan internal"],
  findings: ["Findings", "Temuan"],
  tasks: ["Corrective actions", "Tindakan perbaikan"],
  due: ["Due date", "Tenggat"],
  complete: ["Mark complete", "Tandai selesai"],
  closure: ["Submit for closure review", "Ajukan penutupan untuk ditinjau"],
  outcome: ["Outcome", "Hasil"],
  rationale: ["Internal rationale", "Alasan internal"],
  explanation: ["Explanation for reporter", "Penjelasan untuk pelapor"],
  reviewClosure: ["Review closure", "Tinjau penutupan"],
  accept: ["Approve", "Setujui"],
  reject: ["Reject", "Tolak"],
  hold: ["Legal hold", "Penahanan hukum"],
  requestVerification: [
    "Request contact verification",
    "Minta verifikasi kontak",
  ],
  settings: ["Company settings", "Pengaturan perusahaan"],
  teams: ["Review teams", "Tim peninjau"],
  members: ["Members", "Anggota"],
  restricted: ["Independent restricted team", "Tim independen terbatas"],
  invite: ["Invite staff", "Undang staf"],
  audit: ["Audit history", "Riwayat audit"],
  operations: ["Delivery and retention", "Pengiriman dan retensi"],
  analytics: [
    "Aggregate statistics (groups below five are hidden)",
    "Statistik agregat (kelompok di bawah lima disembunyikan)",
  ],
  refresh: ["Refresh", "Muat ulang"],
  investigatorMessages: [
    "Messages with investigators",
    "Pesan dengan penyelidik",
  ],
  ai: ["Use optional assisted intake", "Gunakan panduan AI opsional"],
  aiConsent: [
    "I consent to MiniMax processing my submitted report and private follow-up conversation. I will review updates before sharing them with investigators.",
    "Saya menyetujui MiniMax memproses laporan terkirim dan percakapan tindak lanjut pribadi saya. Saya akan meninjau pembaruan sebelum membagikannya kepada penyelidik.",
  ],
  draft: ["Create an editable draft", "Buat draf yang dapat diedit"],
  withdraw: [
    "Withdraw AI consent and erase conversation",
    "Tarik persetujuan AI dan hapus percakapan",
  ],
  received: ["Received", "Diterima"],
  triage: ["Triage", "Peninjauan awal"],
  investigating: ["Investigating", "Diselidiki"],
  waiting_reporter: ["Waiting for reporter", "Menunggu pelapor"],
  closure_review: ["Closure review", "Peninjauan penutupan"],
  closed: ["Closed", "Ditutup"],
  analyst: ["Analyst", "Analis"],
  manager: ["Case manager", "Manajer kasus"],
  admin: ["System administrator", "Administrator sistem"],
  substantiated: ["Substantiated", "Terbukti"],
  partially_substantiated: ["Partially substantiated", "Sebagian terbukti"],
  unsubstantiated: ["Unsubstantiated", "Tidak terbukti"],
  out_of_scope: ["Out of scope", "Di luar cakupan"],
  duplicate: ["Duplicate", "Duplikat"],
  withdrawn: ["Withdrawn", "Ditarik"],
  pending: ["Pending", "Menunggu"],
  none: ["Unverified", "Belum diverifikasi"],
  quarantined: ["Processing", "Diproses"],
  published: ["Shared", "Dibagikan"],
  rejected: ["Rejected", "Ditolak"],
  overdue: ["Overdue", "Lewat tenggat"],
  unread: ["Unread", "Belum dibaca"],
  companyName: ["Company name", "Nama perusahaan"],
  acknowledgmentDays: [
    "Acknowledgment deadline (days)",
    "Tenggat konfirmasi (hari)",
  ],
  followupDays: ["Follow-up deadline (days)", "Tenggat tindak lanjut (hari)"],
  retention: ["Retention in days", "Retensi dalam hari"],
  cases: ["Cases", "Kasus"],
  evidence: ["Evidence", "Bukti"],
  transcripts: ["Private AI conversations", "Percakapan AI pribadi"],
  backups: ["Backups", "Cadangan"],
  defaultTeamId: ["Standard review team", "Tim peninjau biasa"],
  restrictedTeamId: ["Independent review team", "Tim peninjau independen"],
  aiEnabled: [
    "Enable optional MiniMax intake",
    "Aktifkan panduan MiniMax opsional",
  ],
  add: ["Add", "Tambah"],
  businessUnits: ["Business units", "Unit bisnis"],
  notificationTemplates: ["Generic notification text", "Teks notifikasi umum"],
  sessions: ["Signed-in sessions", "Sesi masuk"],
  revoke: ["Revoke", "Cabut"],
  copy: ["Copy secrets", "Salin rahasia"],
  copyItem: ["Copy", "Salin"],
  copyAll: ["Copy all credentials", "Salin semua kredensial"],
  copied: ["Copied!", "Tersalin!"],
  download: ["Download receipt", "Unduh tanda terima"],
  done: ["Saved", "Tersimpan"],
  request: ["Request", "Permintaan"],
  verifyRequests: ["Verification requests", "Permintaan verifikasi"],
  check: ["Check", "Periksa"],
  severity: ["Severity", "Keparahan"],
  normal: ["Normal", "Normal"],
  menu: ["Menu", "Menu"],
  closeMenu: ["Close menu", "Tutup menu"],
  workspace: ["Workspace", "Ruang kerja"],
  administration: ["Administration", "Administrasi"],
  users: ["Users", "Pengguna"],
  edit: ["Edit", "Edit"],
  yes: ["Yes", "Ya"],
  no: ["No", "Tidak"],
  passwordResetHeading: ["Password reset", "Pengaturan ulang kata sandi"],
  createUser: ["Create user", "Buat pengguna"],
  editUser: ["Edit user", "Edit pengguna"],
  userActions: ["Actions", "Tindakan"],
  breadcrumbs: ["Breadcrumbs", "Jejak navigasi"],
  backToUsers: ["Back to users", "Kembali ke pengguna"],
  saveChanges: ["Save changes", "Simpan perubahan"],
  noUsers: ["No users yet.", "Belum ada pengguna."],
  usersIntro: [
    "Staff accounts for the review and administration workspace. Reporter eligibility is managed separately under Employees.",
    "Akun staf untuk ruang kerja peninjauan dan administrasi. Kelayakan pelapor dikelola secara terpisah di Karyawan.",
  ],
  userInvitationIntro: [
    "An invitation email will let this user choose a password and enroll an authenticator before accessing the workspace.",
    "Email undangan memungkinkan pengguna memilih kata sandi dan mendaftarkan autentikator sebelum mengakses ruang kerja.",
  ],
  userInvited: [
    "User created. An invitation email was queued.",
    "Pengguna dibuat. Email undangan telah masuk antrean.",
  ],
  userEmailReadOnly: [
    "The account email cannot be changed here.",
    "Email akun tidak dapat diubah di sini.",
  ],
  userUnavailable: [
    "This user no longer exists.",
    "Pengguna ini sudah tidak tersedia.",
  ],
  sendPasswordReset: [
    "Send password reset email",
    "Kirim email pengaturan ulang kata sandi",
  ],
  userResetIntro: [
    "Send a single-use link to this user's account email. The link expires in 30 minutes. Authenticator MFA stays enabled, and existing sessions end after the password is changed.",
    "Kirim tautan sekali pakai ke email akun pengguna ini. Tautan berlaku 30 menit. MFA autentikator tetap aktif, dan sesi yang ada berakhir setelah kata sandi diubah.",
  ],
  userResetInactive: [
    "Password reset is available only for active accounts.",
    "Pengaturan ulang kata sandi hanya tersedia untuk akun aktif.",
  ],
  userResetQueued: [
    "Password reset email queued.",
    "Email pengaturan ulang kata sandi masuk antrean.",
  ],
  staffMembers: ["Staff", "Staf"],
  employees: ["Employees", "Karyawan"],
  statistics: ["Statistics", "Statistik"],
  account: ["Account", "Akun"],
  overview: ["Overview", "Ringkasan"],
  investigation: ["Investigation", "Penyelidikan"],
  closureMenu: ["Closure & legal hold", "Penutupan & penahanan hukum"],
  caseSection: ["Case section", "Bagian kasus"],
  accessDenied: [
    "You do not have access to this page",
    "Anda tidak memiliki akses ke halaman ini",
  ],
  returnToWork: ["Return to workspace", "Kembali ke ruang kerja"],
  retryConnection: [
    "Check your connection and reload to try again.",
    "Periksa koneksi Anda dan muat ulang untuk mencoba lagi.",
  ],
  discardDraft: [
    "Discard unsaved changes",
    "Buang perubahan yang belum disimpan",
  ],
  noCases: [
    "No cases match this filter.",
    "Tidak ada kasus yang sesuai filter ini.",
  ],
  unavailableCase: [
    "This case is unavailable or you do not have access.",
    "Kasus ini tidak tersedia atau Anda tidak memiliki akses.",
  ],
  company: ["Company", "Perusahaan"],
  policies: ["Policies and notification text", "Kebijakan dan teks notifikasi"],
  categoriesUnits: [
    "Categories and business units",
    "Kategori dan unit bisnis",
  ],
  routingDeadlines: ["Routing and deadlines", "Perutean dan tenggat"],
  assistedIntake: ["Assisted intake", "Panduan pelaporan"],
  policyHistory: ["Policy history", "Riwayat kebijakan"],
  savedChanges: ["Changes saved", "Perubahan tersimpan"],
  noEvidence: ["No shared evidence yet.", "Belum ada bukti yang dibagikan."],
  admissionMode: ["Reporter admission mode", "Mode akses pelapor"],
  admission_directory: ["Employee directory only", "Hanya direktori karyawan"],
  admission_directory_or_request: [
    "Employee directory or access request",
    "Direktori karyawan atau permintaan akses",
  ],
  admission_any_verified_email: [
    "Any verified email address",
    "Semua alamat email terverifikasi",
  ],
  relationship: ["Relationship to organization", "Hubungan dengan organisasi"],
  rel_employee: ["Current employee", "Karyawan saat ini"],
  rel_former_employee: ["Former employee", "Mantan karyawan"],
  rel_contractor_supplier: [
    "Contractor or supplier",
    "Kontraktor atau pemasok",
  ],
  rel_external: ["External stakeholder", "Pihak eksternal"],
  acknowledgeReceipt: [
    "Acknowledge formal receipt",
    "Konfirmasi penerimaan resmi",
  ],
  acknowledgedOn: ["Acknowledged", "Dikonfirmasi"],
  acknowledgmentDue: ["Acknowledgment due", "Batas konfirmasi"],
  nextFollowupDue: ["Next follow-up due", "Batas tindak lanjut berikutnya"],
  detrimentRisk: ["Detriment risk level", "Tingkat risiko balasan/detrimen"],
  risk_unassessed: ["Unassessed", "Belum dinilai"],
  risk_low: ["Low", "Rendah"],
  risk_elevated: ["Elevated", "Tinggi"],
  risk_critical: ["Critical", "Kritis"],
  protectionPlan: ["Reporter protection plan", "Rencana perlindungan pelapor"],
  detrimentHeading: [
    "Report retaliation or detriment",
    "Laporkan tindakan balasan atau detrimen",
  ],
  detrimentNotice: [
    "If you experience retaliation, intimidation, or disadvantage related to this report, submit details here at any time—even after closure.",
    "Jika Anda mengalami tindakan balasan, intimidasi, atau kerugian terkait laporan ini, kirim rinciannya di sini kapan saja—bahkan setelah kasus ditutup.",
  ],
  submitDetriment: ["Submit detriment report", "Kirim laporan detrimen"],
  detrimentReports: [
    "Retaliation / detriment reports",
    "Laporan tindakan balasan / detrimen",
  ],
  detrimentFlagged: [
    "Detriment reported — reassessment needed",
    "Detrimen dilaporkan — perlu penilaian ulang",
  ],
  rootCause: ["Root cause category", "Kategori akar penyebab"],
  rc_control_gap: ["Control gap", "Celah pengendalian"],
  rc_policy_gap: ["Policy gap", "Celah kebijakan"],
  rc_training_gap: ["Training / awareness gap", "Celah pelatihan / kesadaran"],
  rc_culture_leadership: ["Culture / leadership", "Budaya / kepemimpinan"],
  rc_individual_misconduct: ["Individual misconduct", "Pelanggaran individu"],
  rc_third_party: ["Third-party / vendor", "Pihak ketiga / vendor"],
  rc_not_applicable: ["Not applicable", "Tidak berlaku"],
  proceduralFairness: [
    "Procedural fairness & subject safeguards (ISO 37002)",
    "Keadilan prosedural & perlindungan terlapor (ISO 37002)",
  ],
  conflictChecked: [
    "Team independence and absence of conflict of interest verified",
    "Independensi tim dan ketiadaan konflik kepentingan telah diverifikasi",
  ],
  subjectConfidentialityProtected: [
    "Identity and confidentiality of subjects/third parties protected",
    "Identitas dan kerahasiaan pihak terlapor/pihak ketiga dilindungi",
  ],
  subjectResponseStatus: [
    "Subject right to be heard",
    "Hak pihak terlapor untuk didengar",
  ],
  srs_not_applicable: ["Not applicable", "Tidak berlaku"],
  srs_heard: [
    "Subject was given opportunity to respond",
    "Terlapor telah diberi kesempatan menanggapi",
  ],
  srs_deferred_legal_or_safety: [
    "Deferred for legal, evidence, or safety risk",
    "Ditunda karena risiko hukum, bukti, atau keselamatan",
  ],
  subjectResponseRationale: [
    "Subject response or deferral summary",
    "Ringkasan tanggapan terlapor atau alasan penundaan",
  ],
  feedbackHeading: [
    "Post-closure process feedback (optional)",
    "Umpan balik proses pasca-penutupan (opsional)",
  ],
  feedbackTrust: ["Trust in process (1–5)", "Kepercayaan pada proses (1–5)"],
  feedbackCommunication: [
    "Clarity of communication (1–5)",
    "Kejelasan komunikasi (1–5)",
  ],
  feedbackProtection: [
    "Confidence in protection (1–5)",
    "Keyakinan atas perlindungan (1–5)",
  ],
  submitFeedback: ["Submit feedback", "Kirim umpan balik"],
  feedbackSubmitted: [
    "Thank you. Your anonymous process feedback has been recorded.",
    "Terima kasih. Umpan balik anonim Anda telah tercatat.",
  ],
  slaMetrics: ["SLA timeliness", "Ketepatan waktu SLA"],
  rootCausesMetrics: ["Root causes", "Akar penyebab"],
  detrimentMetrics: ["Protection & detriment", "Perlindungan & detrimen"],
  feedbackMetrics: ["Reporter feedback", "Umpan balik pelapor"],
} satisfies Record<string, readonly [string, string]>;
export type Lang = "en" | "id";
export function useLanguage() {
  const [lang, setLang] = useState<Lang>("en");
  useEffect(() => {
    const l = localStorage.getItem("wb_language");
    if (l === "id") setLang("id");
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return {
    lang,
    setLang: (v: Lang) => {
      localStorage.setItem("wb_language", v);
      setLang(v);
    },
    t: (key: string) =>
      strings[key as keyof typeof strings]?.[lang === "id" ? 1 : 0] ??
      key.replaceAll("_", " "),
  };
}
export function Shell({
  children,
  language,
}: {
  children: ReactNode;
  language: ReturnType<typeof useLanguage>;
}) {
  const { lang, setLang, t } = language;
  const pathname = usePathname();
  const links = [
    { href: "/report", key: "report" },
    { href: "/case", key: "portal" },
    { href: "/staff", key: "staff" },
  ];
  return (
    <div className={`suite${pathname === "/staff" ? " suite-workspace" : ""}`}>
      <a className="skip-link" href="#main-content">
        {t("skip")}
      </a>
      <header className="suite-header">
        <div className="brand-lockup">
          <Link className="wordmark" href="/">
            Speak Up
          </Link>
          <span className="brand-caption">Lixionary</span>
        </div>
        <nav aria-label={t("navigation")}>
          {links.map(({ href, key }) => (
            <Link
              key={href}
              href={href}
              aria-current={
                pathname === href || pathname.startsWith(`${href}/`)
                  ? "page"
                  : undefined
              }
            >
              {t(key)}
            </Link>
          ))}
          <LanguageSelector value={lang} onChange={setLang} />
        </nav>
      </header>
      <main
        id="main-content"
        tabIndex={-1}
        className="suite-main suite-content"
      >
        {children}
      </main>
      <footer className="suite-footer">
        <span>
          <ShieldCheck size={16} aria-hidden="true" />
          {t("confidential")}
        </span>
        <span>
          Speak Up · Lixionary · <BuildSignature />
        </span>
      </footer>
    </div>
  );
}

export function StatusBadge({
  state,
  children,
}: {
  state: string;
  children: ReactNode;
}) {
  const tone = ["overdue", "rejected", "hold", "critical"].includes(state)
    ? "danger"
    : [
          "pending",
          "quarantined",
          "waiting_reporter",
          "closure_review",
          "high",
        ].includes(state)
      ? "warn"
      : ["closed", "verified", "published", "substantiated"].includes(state)
        ? "ok"
        : ["received", "triage", "investigating", "unread"].includes(state)
          ? "info"
          : ["admin", "manager", "analyst"].includes(state)
            ? "accent"
            : "neutral";
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label>
      {label}
      <input {...props} />
    </label>
  );
}
export function Text({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <label>
      {label}
      <textarea rows={4} {...props} />
    </label>
  );
}
export function Check({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="check">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
export function Select({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return (
    <label>
      {label}
      <select {...props}>{children}</select>
    </label>
  );
}
export function ErrorBox({ error }: { error: string }) {
  return error ? (
    <p role="alert" className="error">
      {error}
    </p>
  ) : null;
}
const errors: Record<string, [string, string]> = {
  jira_disabled: [
    "The development tracker is not configured yet.",
    "Pelacak pengembangan belum dikonfigurasi.",
  ],
  jira_unavailable: [
    "Lixionary Jira is unavailable. Please try again.",
    "Lixionary Jira tidak tersedia. Silakan coba lagi.",
  ],
  staff_exists: [
    "A user with this email already exists.",
    "Pengguna dengan email ini sudah ada.",
  ],
  staff_inactive: [
    "Password reset is available only for active accounts.",
    "Pengaturan ulang kata sandi hanya tersedia untuk akun aktif.",
  ],
  report_access_required: [
    "Verify your employee email to continue. Your draft is kept on this page.",
    "Verifikasi email karyawan Anda untuk melanjutkan. Draf tetap tersimpan di halaman ini.",
  ],
  report_busy: [
    "Another report operation is in progress. Please wait.",
    "Operasi laporan lain sedang berjalan. Silakan tunggu.",
  ],
  duplicate_email: [
    "This email is already registered. Edit the existing employee instead.",
    "Email ini sudah terdaftar. Ubah karyawan yang ada.",
  ],
  employee_exists: [
    "This email is already registered. Return to email verification.",
    "Email ini sudah terdaftar. Kembali ke verifikasi email.",
  ],
  request_resolved: [
    "This request has already been resolved. Refresh the list.",
    "Permintaan sudah diputuskan. Muat ulang daftar.",
  ],
  request_verification_required: [
    "Verify the request email again.",
    "Verifikasi email permintaan kembali.",
  ],
  intake_already_started: [
    "This verification already started an AI conversation. Continue with your report form.",
    "Verifikasi ini sudah memulai percakapan AI. Lanjutkan dengan formulir laporan.",
  ],
  ai_unavailable: [
    "The assistant is unavailable. Your message is saved. Use Retry to continue.",
    "Asisten tidak tersedia. Pesan Anda tersimpan. Gunakan Coba lagi untuk melanjutkan.",
  ],
  conversation_busy: [
    "The assistant is working on a reply. Please wait.",
    "Asisten sedang menyiapkan balasan. Silakan tunggu.",
  ],
  conversation_retry_required: [
    "Retry the saved message before sending another.",
    "Coba lagi pesan tersimpan sebelum mengirim pesan lain.",
  ],
  message_conflict: [
    "This update was already sent with different content. Refresh and review the case messages.",
    "Pembaruan ini sudah dikirim dengan isi berbeda. Muat ulang dan tinjau pesan laporan.",
  ],
  conversation_limit: [
    "Today’s AI allowance has been reached. Your conversation is saved; continue after the UTC daily reset.",
    "Batas AI hari ini tercapai. Percakapan tersimpan; lanjutkan setelah pergantian hari UTC.",
  ],
  policy_changed: [
    "The company policy changed. Review it again before continuing; your report text is kept on this page.",
    "Kebijakan perusahaan berubah. Tinjau kembali sebelum melanjutkan; teks laporan Anda tetap ada di halaman ini.",
  ],
  preview_changed: [
    "This preview changed. Open it again and review the current version.",
    "Pratinjau berubah. Buka kembali dan tinjau versi terbaru.",
  ],
  case_file_limit: [
    "This case has reached its file or storage limit.",
    "Kasus ini telah mencapai batas file atau penyimpanan.",
  ],
  submission_expired: [
    "This saved submission has expired. Start a new report.",
    "Laporan tersimpan ini telah kedaluwarsa. Buat laporan baru.",
  ],
  sms_unavailable: [
    "Phone verification is currently unavailable. You can use email or continue anonymously.",
    "Verifikasi telepon belum tersedia. Anda dapat menggunakan email atau tetap anonim.",
  ],
  email_unavailable: [
    "Email verification is currently unavailable. Please try again later.",
    "Verifikasi email belum tersedia. Silakan coba lagi nanti.",
  ],
  ai_disabled: [
    "Assisted intake is unavailable. Use the report form below.",
    "Panduan AI belum tersedia. Gunakan formulir laporan di bawah.",
  ],
  invalid_code: [
    "Invalid or already used code. Wait for a new authenticator code or use a saved recovery code.",
    "Kode salah atau sudah digunakan. Tunggu kode autentikator baru atau gunakan kode pemulihan tersimpan.",
  ],
  legal_hold: [
    "These records are currently subject to a legal hold.",
    "Catatan ini sedang dalam penahanan hukum.",
  ],
  retention_in_progress: [
    "Cleanup is in progress. Try setting the hold again in two minutes.",
    "Pembersihan sedang berlangsung. Coba penahanan lagi dalam dua menit.",
  ],
  unauthorized: [
    "Your session expired. Sign in again.",
    "Sesi Anda berakhir. Silakan masuk kembali.",
  ],
  google_cancelled: [
    "Google sign-in was cancelled. Try again or use your password.",
    "Proses masuk Google dibatalkan. Coba lagi atau gunakan kata sandi Anda.",
  ],
  google_expired: [
    "Google sign-in expired. Please start again.",
    "Proses masuk Google kedaluwarsa. Silakan mulai lagi.",
  ],
  google_ineligible: [
    "This Google account cannot sign in to the staff portal. Use your staff password or contact your administrator.",
    "Akun Google ini tidak dapat masuk ke portal staf. Gunakan kata sandi staf atau hubungi administrator Anda.",
  ],
  google_disabled: [
    "Google sign-in is unavailable. Use your staff password.",
    "Login Google tidak tersedia. Gunakan kata sandi staf Anda.",
  ],
  google_failed: [
    "Google sign-in could not be completed. Try again or use your password.",
    "Login Google belum dapat diselesaikan. Coba lagi atau gunakan kata sandi Anda.",
  ],
  mfa_required: [
    "Authenticator verification is required.",
    "Verifikasi autentikator diperlukan.",
  ],
  invalid_credentials: [
    "Check your code and saved secret.",
    "Periksa kode dan rahasia tersimpan Anda.",
  ],
  invalid_or_expired_code: [
    "The verification code is incorrect or expired.",
    "Kode verifikasi salah atau kedaluwarsa.",
  ],
  rate_limit: [
    "Too many attempts. Please wait and try again.",
    "Terlalu banyak percobaan. Tunggu sebelum mencoba lagi.",
  ],
  otp_rate_limit: [
    "Wait before requesting or trying another code.",
    "Tunggu sebelum meminta atau mencoba kode lain.",
  ],
  configuration_incomplete: [
    "Company setup is incomplete.",
    "Pengaturan perusahaan belum lengkap.",
  ],
  reviewer_capacity: [
    "Each review team needs two active managers.",
    "Setiap tim peninjau memerlukan dua manajer aktif.",
  ],
  team_overlap: [
    "The restricted team must have independent members.",
    "Anggota tim terbatas harus independen.",
  ],
  independent_review_required: [
    "A different case manager must approve closure.",
    "Manajer kasus yang berbeda harus menyetujui penutupan.",
  ],
  open_corrective_actions: [
    "Complete corrective actions before requesting closure.",
    "Selesaikan tindakan perbaikan sebelum mengajukan penutupan.",
  ],
  not_found: [
    "This item is unavailable or you do not have access.",
    "Item tidak tersedia atau Anda tidak memiliki akses.",
  ],
  invalid_transition: [
    "This status change is unavailable.",
    "Perubahan status ini tidak tersedia.",
  ],
  feedback_exists: [
    "Feedback has already been submitted for this case.",
    "Umpan balik sudah pernah dikirim untuk kasus ini.",
  ],
  case_closed: [
    "This case is closed. Request reopening to continue.",
    "Kasus ditutup. Minta dibuka kembali untuk melanjutkan.",
  ],
};
export function friendly(e: unknown, lang: Lang) {
  if (e instanceof ApiError) {
    if (e.code === "validation_error")
      return e.issues.length
        ? e.issues.map((i) => `${i.path}: ${i.message}`).join(" · ")
        : lang === "id"
          ? "Periksa kolom yang wajib diisi."
          : "Check the required fields.";
    return (
      errors[e.code]?.[lang === "id" ? 1 : 0] ??
      (lang === "id"
        ? "Permintaan gagal. Coba lagi."
        : "The request failed. Try again.")
    );
  }
  return lang === "id"
    ? "Tidak dapat terhubung. Periksa koneksi Anda."
    : "Unable to connect. Check your connection.";
}
export function useAction(lang: Lang) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(friendly(e, lang));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run, setError };
}
export function usePoll(fn: () => Promise<void>) {
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void fn().catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, [fn]);
}
export async function privateApi<T>(
  path: string,
  opts: Parameters<typeof api>[1] = {},
) {
  const { capability } = await api<{ capability: string }>(
    "/api/reporter/capability",
    { method: "POST", body: {} },
  );
  return api<T>(`/privacy/reporter${path}`, {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${capability}` },
  });
}
export function Receipt({
  receipt,
  onDone,
  t,
}: {
  receipt: {
    caseCode: string;
    pin: string;
    recoverySecret: string;
    capability?: string;
    challengeId?: string;
    reporterEmail?: string;
  };
  onDone: () => void;
  t: (s: string) => string;
}) {
  const [saved, setSaved] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState("");

  const copy = (key: string, value: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((curr) => (curr === key ? null : curr));
    }, 2000);
  };

  const text = `${t("caseCode")}: ${receipt.caseCode}\n${t("pin")}: ${receipt.pin}\n${t("recovery")}: ${receipt.recoverySecret}\n`;
  return (
    <section>
      <h1>{receipt.caseCode}</h1>
      <p>{t("receipt")}</p>
      <dl>
        <dt>{t("caseCode")}</dt>
        <div className="receipt-field">
          <dd className="case-id">{receipt.caseCode}</dd>
          <button
            type="button"
            className="copy-btn"
            onClick={() => copy("caseCode", receipt.caseCode)}
            aria-label={`${t("copyItem")} ${t("caseCode")}`}
          >
            {copiedKey === "caseCode" ? t("copied") : t("copyItem")}
          </button>
        </div>
        <dt>{t("pin")}</dt>
        <div className="receipt-field">
          <dd className="secret">{receipt.pin}</dd>
          <button
            type="button"
            className="copy-btn"
            onClick={() => copy("pin", receipt.pin)}
            aria-label={`${t("copyItem")} ${t("pin")}`}
          >
            {copiedKey === "pin" ? t("copied") : t("copyItem")}
          </button>
        </div>
        <dt>{t("recovery")}</dt>
        <div className="receipt-field">
          <dd className="secret">{receipt.recoverySecret}</dd>
          <button
            type="button"
            className="copy-btn"
            onClick={() => copy("recovery", receipt.recoverySecret)}
            aria-label={`${t("copyItem")} ${t("recovery")}`}
          >
            {copiedKey === "recovery" ? t("copied") : t("copyItem")}
          </button>
        </div>
      </dl>
      <div className="receipt-actions">
        <button type="button" onClick={() => copy("all", text)}>
          {copiedKey === "all" ? t("copied") : t("copyAll")}
        </button>{" "}
        <button
          type="button"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([text], { type: "text/plain" }),
            );
            const a = document.createElement("a");
            a.href = url;
            a.download = `private-report-${receipt.caseCode}.txt`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          {t("download")}
        </button>
      </div>
      {receipt.challengeId && receipt.reporterEmail && (
        <article className="receipt-otp-box">
          <h3>{t("verifyEmailNotification")}</h3>
          {otpVerified ? (
            <p style={{ color: "green" }}>{t("emailVerifiedSuccess")}</p>
          ) : (
            <>
              <p>
                {t("verifyEmailNotificationDesc").replace(
                  "%s",
                  receipt.reporterEmail,
                )}
              </p>
              <ErrorBox error={otpError} />
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <Field
                  label={t("verify")}
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                />
                <button
                  type="button"
                  disabled={otpBusy || otpCode.length !== 6}
                  onClick={() => {
                    setOtpBusy(true);
                    setOtpError("");
                    privateApi("/contacts/verify", {
                      method: "POST",
                      body: { challengeId: receipt.challengeId, code: otpCode },
                    })
                      .then(() => setOtpVerified(true))
                      .catch((e) => setOtpError(String(e?.message ?? e)))
                      .finally(() => setOtpBusy(false));
                  }}
                >
                  {t("verify")}
                </button>
              </div>
            </>
          )}
        </article>
      )}
      <Check
        label={t("saved")}
        checked={saved}
        onChange={(e) => setSaved(e.target.checked)}
      />
      <button disabled={!saved} onClick={onDone}>
        {t("portal")}
      </button>
    </section>
  );
}
