"""
Central place where all environment variables and Zoho URL patterns live.
Everything else in the app imports from here instead of touching os.environ
directly - so if a domain/URL changes, you only fix it in one place.
"""
import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _secret(name: str, default: str = "") -> str:
    """An env value with whitespace and wrapping quotes removed. Pasting
    "abc" (with the quotes) into Render's dashboard stores the quotes too,
    which silently breaks a password or token."""
    value = (os.getenv(name) or default).strip()
    while len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1].strip()
    return value


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


ZOHO_DOMAIN = os.getenv("ZOHO_DOMAIN", "in").strip().lstrip(".")

ZOHO_CLIENT_ID = _secret("ZOHO_CLIENT_ID")
ZOHO_CLIENT_SECRET = _secret("ZOHO_CLIENT_SECRET")
ZOHO_REFRESH_TOKEN = _secret("ZOHO_REFRESH_TOKEN")

OPENAI_API_KEY = _secret("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

# ---- Token budget ----
# Resume text sent to the AI is compacted then capped at this many characters
# (~4 chars per token; 14000 chars covers a dense 3-4 page resume).
MAX_RESUME_CHARS = int(os.getenv("MAX_RESUME_CHARS", "14000"))
QUICK_MAX_OUTPUT_TOKENS = 1400
FULL_MAX_OUTPUT_TOKENS = 3500

# USD per 1M tokens, used only for the estimated cost shown in the dashboard.
# Defaults are gpt-4o-mini list prices - update if you change OPENAI_MODEL.
PRICE_INPUT_PER_M = float(os.getenv("PRICE_INPUT_PER_M", "0.15"))
PRICE_CACHED_INPUT_PER_M = float(os.getenv("PRICE_CACHED_INPUT_PER_M", "0.075"))
PRICE_OUTPUT_PER_M = float(os.getenv("PRICE_OUTPUT_PER_M", "0.60"))

FLASK_SECRET_KEY = os.getenv("FLASK_SECRET_KEY", "dev-secret-change-me")

DATABASE_PATH = os.getenv("DATABASE_PATH", os.path.join(BASE_DIR, "screener.db"))

# ---- Derived Zoho endpoints (based on ZOHO_DOMAIN) ----
ACCOUNTS_BASE = f"https://accounts.zoho.{ZOHO_DOMAIN}"
WORKDRIVE_API_BASE = f"https://www.zohoapis.{ZOHO_DOMAIN}/workdrive/api/v1"
RECRUIT_API_BASE = f"https://recruit.zoho.{ZOHO_DOMAIN}/recruit/v2"

TOKEN_URL = f"{ACCOUNTS_BASE}/oauth/v2/token"
AUTH_URL = f"{ACCOUNTS_BASE}/oauth/v2/auth"

# Combined scope string used when generating the refresh token.
#   WorkDrive.files.READ      list folders, download resumes, verify file ancestry
#   WorkDrive.files.CREATE    create role/date folders and upload resumes from the app
#   WorkDrive.files.UPDATE    move a passed resume to trash (first half of delete)
#   WorkDrive.files.DELETE    permanently remove it from trash
#   ZohoRecruit.modules.ALL   create/update Candidates and attach resumes
#   ZohoRecruit.settings.READ read Candidates field types + picklist options, so
#                             values are coerced correctly instead of rejected
OAUTH_SCOPES = (
    "WorkDrive.files.READ,WorkDrive.files.CREATE,WorkDrive.files.UPDATE,WorkDrive.files.DELETE,"
    "ZohoRecruit.modules.ALL,ZohoRecruit.settings.READ"
)

# ---- WorkDrive folder layout ----
# ROOT / <role folder, e.g. "Full Stack"> / <date folder, e.g. "16 Sept"> / resumes
# The role folder (first level under ROOT) owns the job description. Screening
# can run on any folder at or below role level that holds resumes.
WORKDRIVE_ROOT_FOLDER_ID = os.getenv(
    "WORKDRIVE_ROOT_FOLDER_ID", "2zlwtb06b69f6279d461c9aee79190bdf257e"
).strip()

SUPPORTED_RESUME_EXTENSIONS = {".pdf", ".docx"}

# ---- Screening ----
# The AI scores resume + Google Form answers together on 0-100, and the score
# becomes a band. High and Medium go to Zoho Recruit; Low stays in WorkDrive.
BAND_HIGH = 75     # 75-100 -> High
BAND_MEDIUM = 50   # 50-74  -> Medium, below 50 -> Low
# Kept for older runs/JDs that stored a numeric pass mark; new runs use BAND_MEDIUM.
DEFAULT_PASS_THRESHOLD = BAND_MEDIUM


def band(score) -> str:
    if score is None:
        return ""
    return "High" if score >= BAND_HIGH else "Medium" if score >= BAND_MEDIUM else "Low"


# ---- Google Form responses ----
# Resumes whose candidate hasn't filled the role's Google Form are moved here,
# inside the role folder: ROOT / <role> / Form Pending.
FORM_PENDING_FOLDER = "Form Pending"
# Walk-in candidates (added by HR in the app) are filed in ROOT / <role> / Walk-in.
# They skip the Google Form check, are scored on resume + HR notes, and stay in
# the app only: never pushed to Recruit, never deleted from WorkDrive.
WALKIN_FOLDER = "Walk-in"
# Scanned / photographed resumes: at most this many pages are read with AI OCR.
OCR_MAX_PAGES = int(os.getenv("OCR_MAX_PAGES", "3"))
# How often the background watcher re-reads the response sheets (minutes).
FORM_CHECK_MINUTES = int(os.getenv("FORM_CHECK_MINUTES", "10"))
# A response sheet is re-downloaded at most this often (seconds).
SHEET_CACHE_SECONDS = 60

# Kill switch for the automatic permanent delete of passed resumes. With it
# off, passed candidates still go to Recruit but every file stays in WorkDrive.
WORKDRIVE_DELETE_ENABLED = _bool("WORKDRIVE_DELETE_ENABLED", True)

# Safety cap on how far up the parent chain the delete guard walks looking for
# ROOT. Real layout is 2-3 levels; hitting this means the file is not ours.
MAX_FOLDER_DEPTH = 10

# ---- Zoho Recruit ----
RECRUIT_DUPLICATE_FIELD = os.getenv("RECRUIT_DUPLICATE_FIELD", "Email")

# Recruit api_names for the AI score fields. Create them in Recruit (Setup ->
# Modules and Fields -> Candidates) and the app writes to them automatically.
# Any that don't exist yet are skipped with a logged warning - never a failure.
RECRUIT_SCORE_FIELDS = {
    "overall_score": "Overall_score",   # exists (Single Line text)
    "ai_score": "AI_Score",             # create as Number
    "skill_score": "Skill_Score",       # create as Number
    "summary": "AI_Summary",            # create as Multi Line
}

# Attachment categories tried in order when uploading a resume to a Candidate.
# "Resume" is the correct one but accepts only a single file per candidate,
# so "Others" catches re-uploads for a candidate who already has one.
RECRUIT_ATTACHMENT_CATEGORIES = ("Resume", "Others")

# ---- Email fetch (Indeed application emails -> WorkDrive) ----
# Gmail needs IMAP enabled and a 16-char App Password (Google Account ->
# Security -> 2-Step Verification -> App passwords). The normal password won't work.
EMAIL_IMAP_HOST = os.getenv("EMAIL_IMAP_HOST", "imap.gmail.com").strip()
EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS", "helios.cvtechlabs@gmail.com").strip()
EMAIL_APP_PASSWORD = _secret("EMAIL_APP_PASSWORD").replace(" ", "")
# Only application emails whose subject contains this are processed.
EMAIL_SUBJECT_FILTER = os.getenv("EMAIL_SUBJECT_FILTER", "New application for").strip()
# How many days back each fetch looks (already-fetched emails are skipped).
EMAIL_LOOKBACK_DAYS = int(os.getenv("EMAIL_LOOKBACK_DAYS", "7"))

# ---- MongoDB backup of screener.db (see db_backup.py) ----
# Set MONGODB_URI (an Atlas mongodb+srv:// string) to keep the database across
# Render free-plan redeploys. Empty = no backup, same as before.
MONGODB_URI = _secret("MONGODB_URI")
MONGODB_DB = os.getenv("MONGODB_DB", "resume_screener").strip() or "resume_screener"

# ---- Google Form invites (sent to applicants after an email fetch) ----
# Sent from EMAIL_ADDRESS through Gmail SMTP with the same App Password.
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com").strip()
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
EMAIL_FROM_NAME = os.getenv("EMAIL_FROM_NAME", "Hiring Team").strip()
# Before sending, Gmail's Sent folder is searched this far back for an earlier
# invite to the same address for the same position, so nobody gets it twice -
# even after a redeploy wipes the database.
INVITE_DEDUPE_DAYS = int(os.getenv("INVITE_DEDUPE_DAYS", "120"))
# Placeholders: {name} {first_name} {position} {form_link}
DEFAULT_INVITE_SUBJECT = "Next step for your {position} application"
DEFAULT_INVITE_BODY = """Hi {first_name},

Thank you for applying for the {position} role. We have received your resume.

As the next step, please fill in this short form:
{form_link}

Please use the same email address and phone number as on your resume, so we can match your answers to your application.

Best regards,
Hiring Team"""

# Each position's settings (JD, sheet link, form link, invite template) are also
# saved as this file inside the position's WorkDrive folder. Render's free plan
# wipes the database on every deploy; on start-up they are restored from here.
ROLE_SETTINGS_FILE = "_screener-settings.json"
