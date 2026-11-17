# Resume Screener — WorkDrive → AI Score → Zoho Recruit

check repo

Ek Flask web app jo:

1. Zoho **WorkDrive** ke ek folder se resumes (.pdf/.docx) one-by-one uthaata hai
2. Har resume ko **OpenAI** se, aapki Job Description ke against, analyze karke
   `ai_score`, `skill_score`, `overall_score` + full JSON verdict deta hai
3. Ek click me candidate ko Zoho **Recruit → Candidates module** me save kar deta hai
   (resume file attachment ke saath)

---

## 0. Pehle yeh decide karo: Zoho account ka region

Aapka Zoho account jis data-center pe signup hua hai (India users usually `in`),
wahi `.env` me `ZOHO_DOMAIN` set karna hoga. Options: `com`, `in`, `eu`, `com.au`, `jp`.
Agar pata nahi, apne Zoho account ke URL me dekho — `recruit.zoho.in` hai ya `recruit.zoho.com`.

---

## 1. Zoho API credentials banao (Client ID / Secret)

1. Browser me kholo: **https://api-console.zoho.<in/com/...>/**
2. **GET STARTED** → **Self Client** pe hover karke **CREATE NOW** dabao.
3. **CREATE** → **OK** — ab **Client Secret** tab me `Client ID` aur `Client Secret` dikhega, copy kar lo.

## 2. Refresh token generate karo (ek baar ka kaam)

```bash
cd zoho_resume_screener
python -m venv venv && source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# .env kholo, ZOHO_DOMAIN, ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET fill karo
```

Ab wapas API Console me, apne Self Client ke andar **Generate Code** tab kholo:

- **Scope** field me yeh exact string paste karo (WorkDrive + Recruit dono ek saath):
  ```
  WorkDrive.files.READ,WorkDrive.files.CREATE,WorkDrive.files.UPDATE,WorkDrive.files.DELETE,ZohoRecruit.modules.ALL,ZohoRecruit.settings.READ
  ```
- **Time Duration** — 10 minutes rakho (bas itni der me exchange karna hai)
- **Scope Description** — kuch bhi likh do, e.g. "resume screener"
- **CREATE** dabao. Agar prompt aaye ki konsa app/portal chahiye, WorkDrive aur Recruit dono select kar dena.
- Ek **grant token** (authorization code) screen pe dikhega — copy kar lo (yeh sirf kuch minute valid rehta hai, jaldi karo).

Ab terminal me:

```bash
python generate_refresh_token.py
```

Jab pooche, wahi grant token paste kar do. Script `ZOHO_REFRESH_TOKEN` print karega — isse `.env` me daal do.

Yeh ek hi refresh token WorkDrive aur Recruit dono ke liye kaam karega, kyunki scope me dono the.

## 3. OpenAI API key

`.env` me `OPENAI_API_KEY` daalo (https://platform.openai.com/api-keys se milega).
`OPENAI_MODEL` default `gpt-4o-mini` hai — accuracy zyada chahiye to `gpt-4o` try karo.

## 4. Zoho Recruit me custom fields banao (sirf ek baar)

AI Score / Skill Score / Overall Score / Summary — yeh Candidates module ke
standard fields nahi hain, inhe khud banana padega:

**Zoho Recruit → Setup → Modules and Fields → Candidates → New Field**

| Field label      | API name (exactly yeh rakhna) | Type            |
| ---------------- | ----------------------------- | --------------- |
| AI Score         | `AI_Score`                    | Number          |
| Skill Score      | `Skill_Score`                 | Number          |
| Overall Score    | `Overall_Score`               | Number          |
| JD Match Summary | `JD_Match_Summary`            | Multi-line text |

Agar tum different API names use karna chahte ho, `config.py` me
`RECRUIT_CUSTOM_SCORE_FIELDS` dict edit kar dena — bas ek jagah change karna hoga.

## 5. WorkDrive folder ID dhoondo

WorkDrive me jis folder me resumes hain usko kholo — URL ke end me jo ID dikhega
(e.g. `.../workdrive/folders/jk3x9f2a8b1c4`), wahi Folder ID hai jo app me daalna hai.

## 6. App run karo

```bash
PORT=5001 python3 app.py
```

Browser me kholo → **http://127.0.0.1:5001** (port 5000 macOS AirPlay use karta hai)

### Flow

WorkDrive layout: `ROOT / <role, e.g. Full Stack> / <date, e.g. 16 Sept> / resumes`

1. **Resumes** tab → role folder kholo → **Job description** save karo
2. Google Form ka response sheet link do - sidebar **Form sheets** page pe (saari positions ek jagah), ya
   position page pe **Google Form responses** card me. Link: Form → Responses → **View in Sheets** → us sheet
   ka URL. Sheet ko Share → "Anyone with the link" → Viewer rakhna (app CSV export se padhta hai, login nahi chahiye).
3. Date folder kholo → resumes upload karo (200 bhi chalega - app 5-5 ke batch me bhejta hai) → **Screen selected**
4. Har resume: download → text + hidden hyperlinks extract → resume se email/phone (regex, AI nahi)
   - Sheet me response **nahi mila** → resume `ROOT / <role> / Form Pending` me move, score nahi hota
     (OpenAI cost bachti hai). **Form pending** tab me list dikhti hai.
   - Response **mila** → AI resume + form answers dono milake 0-100 score deta hai → band:
     **High 75+ · Medium 50-74 · Low <50**
   - **High / Medium** → Recruit me candidate upsert + resume attach → read-back verify →
     WorkDrive se **permanently delete**
   - **Low** → WorkDrive me hi rehta hai
5. App har 10 min (`FORM_CHECK_MINUTES`) sheets dobara padhta hai. Pending candidate ne form bhar diya →
   sidebar me **Form pending** pe notification count → wahan **Screen filled forms** dabao.
6. Folder page pe **Rename / Delete** (folder), aur resumes select karke **Move / Delete** - delete WorkDrive
   trash me jata hai (30 din restore ho sakta hai).
7. **Activity log** tab → har run, Recruit push, move aur deletion ka audit (`screener.db`)

Role pe sheet link nahi hai → resume akela score hota hai (purana behaviour), Form Pending use nahi hota.

### Roz ka kaam: sirf aaj ke resumes

Folder ki resume list timeline hai: newest first, din ke hisaab se groups (Today / Yesterday / 12 Nov),
har resume pe **Added** time aur "screened 2h ago".
- **Screen today's uploads (N)** (default): sirf aaj add hue resumes jo abhi tak screen nahi hue.
  Kal ke Low wale dobara nahi chalte; din me doosra batch aaye to sirf naye chalte hain.
- **Re-screen all**: folder ke saare resumes phir se - JD badalne ke baad. Same JD pe pehle score hue
  resumes purana result reuse karte hain (OpenAI cost nahi).
- Haath se chunna ho to checkbox → neeche bar se **Screen N**.

### Walk-in candidates

**+ Add walk-in** (Positions page ya position page) → position, naam, phone/email, HR notes, aur resume:
ek PDF/DOCX, ya printed resume ki photos (har page ki ek photo; phone pe camera chalta hai).
- Photos ek PDF ban ke `ROOT / <position> / Walk-in` me save hoti hain, aur turant scoring shuru hoti hai.
- Google Form check nahi hota. Score = resume + HR notes → High / Medium / Low.
- Walk-ins **sirf app me** rehte hain: Recruit me nahi jaate, WorkDrive se delete nahi hote.
  Candidates page pe **Walk-ins** filter, Dashboard pe count.
- Scanned / photo resumes (walk-in ya normal) ka text AI OCR se padha jaata hai (max 3 page,
  `OCR_MAX_PAGES`): ~₹0.3-0.5 per page, aur 1-2 minute lag sakte hain.

### Naya simple flow: Home · Applicants · Positions

Har applicant ek hi list me, har step pe ek button:

**Gmail se fetch → Google Form bhejo → Form fill hua → Screen (manual) → Qualified / Not qualified**

- **Home**: aaj kya karna hai (form bhejna, screen karna), applied → qualified funnel, aur position-wise table.
- **Applicants**: tabs (New · Waiting for form · Form filled · Qualified · Not qualified), checkbox se select karke
  ek button: *Send Google Form* ya *Screen*. Naam pe click → us applicant ki poori journey + score.
- **Positions**: har position ek baar set karo: JD, Google Form link, response sheet, email text.
- **+ Add applicant** = walk-in. Purane folder pages `#/files` pe abhi bhi hain (Positions → Browse files).
- Form bhejne ke baad app response sheet har `FORM_CHECK_MINUTES` me check karta hai; jisne bhara wo
  "Form filled" me aa jata hai. Screening manual hai.

### Database MongoDB me safe (Render free plan)

Render free plan pe har deploy pe `screener.db` ud jata tha. Ab `MONGODB_URI` set ho to poori database
ki copy MongoDB Atlas me rehti hai (database `resume_screener`, GridFS): har 60 second me (agar kuch badla)
aur shutdown pe. Naye deploy pe app start hote hi wahi copy wapas aa jati hai. Render pe:
Environment → `MONGODB_URI` = Atlas ka `mongodb+srv://...` string. Atlas → Network Access me
`0.0.0.0/0` allowed hona chahiye. Local pe `MONGODB_URI` khali rakho (ya alag copy banti hai,
production kabhi overwrite nahi hota).

### Google Form invites (email se aaye applicants ko form bhejo)

1. **Form sheets** page → har position pe **Add form link** → Google Form ka link
   (form me *Send → link icon → Copy*, `https://forms.gle/...`) aur email ka subject/text.
   Text me `{first_name}` `{name}` `{position}` `{form_link}` placeholders chalte hain.
   **Save & send test to me** se pehle khud ko test mail bhejo.
2. **Fetch from email** ke baad har applicant **Form invites** page pe aa jata hai. Email unke
   resume se padha jata hai; resume me na ho to Indeed mail ka Reply-To (relay address) use hota hai.
   Na mile to wahin type kar do.
3. Check karo, phir **Send** / **Send to all ready** / **Send selected**. **Apne aap kuch nahi jaata.**

- Mail `EMAIL_ADDRESS` se jaati hai (wahi Gmail App Password, SMTP). Sender ka naam `EMAIL_FROM_NAME`.
- **Kisi ko do baar nahi jaata:** bhejne se pehle Gmail ke **Sent** folder me us address ko us
  position ka invite dhoondha jata hai (`X-Screener-Invite` header). Sent folder redeploy pe nahi
  udta, isliye database wipe hone ke baad bhi duplicate nahi jaata.
- Gmail limit: ~500 mails/din (normal account). Har mail ke beech 1 second ka gap hai.

**Settings ab WorkDrive me bhi save hoti hain.** JD, response sheet link, form link aur email
template har save pe `ROOT / <position> / _screener-settings.json` me bhi likhe jaate hain. Free
plan pe redeploy ke baad app start hote hi wahan se wapas aa jaate hain. (Run history, Candidates
list aur Form invites ki list abhi bhi database me hi hai - wo redeploy pe jaati hai.)

### Render pe deploy (free plan)

**1. Code push karo**

```bash
git remote add origin https://github.com/<user>/<repo>.git
git push -u origin main
```

**2. Render me service banao**

Render → **New** → **Blueprint** → repo select karo. `render.yaml` sab padh leta hai
(plan, build command, start command, health check). Phir Environment me ye secrets bharo
(`sync: false` wale - Render inhe khud nahi bhar sakta):

`ZOHO_CLIENT_ID` · `ZOHO_CLIENT_SECRET` · `ZOHO_REFRESH_TOKEN` · `OPENAI_API_KEY` ·
`WORKDRIVE_ROOT_FOLDER_ID` · `EMAIL_APP_PASSWORD`

**3. Loading screen / cold start band karo**

Free plan 15 minute idle ke baad service so jata hai, aur agli baar koi site kholega to
~30-60 second loading screen dekhega. Isliye do pinger lage hain, dono `/healthz` par:

| Pinger | Kahan chalta hai | Kaam |
|---|---|---|
| `keepalive.py` | app ke andar (thread) | Har 10 min apne aap ko ping - service kabhi idle hi nahi hoti. Render ka `RENDER_EXTERNAL_URL` khud use karta hai, kuch set nahi karna. |
| `.github/workflows/keepalive.yml` | GitHub Actions | Har 10 min bahar se ping. Ye backup hai - **soyi hui service ko sirf yahi jaga sakta hai**, kyunki sleeping instance me koi thread nahi chalta. |

GitHub Actions wale ke liye repo me ek secret daalna hai:
**Settings → Secrets and variables → Actions → New repository secret** →
naam `KEEPALIVE_URL`, value `https://<your-service>.onrender.com` (end me slash nahi).

Band karna ho to `KEEPALIVE_ENABLED=false`, ya interval badalna ho to `KEEPALIVE_MINUTES`
(15 se neeche hi rakhna). Status `/api/status` ke `keepalive` field me dikhta hai.

**Free plan ki 3 limits jo pata honi chahiye:**

- **750 instance-hours/month** saari free web services milake. Ise 24/7 jagaye rakhne me
  ~730 hours lagte hain, to ye tumhari **ekloti** free service honi chahiye - warna mahine
  ke end me Render suspend kar dega. (Starter $7 pe ye limit hai hi nahi.)
- **Persistent disk nahi milta.** Har deploy/restart pe `screener.db` ud jata hai. JDs, sheet
  links, form links aur email templates WorkDrive ki settings file se khud wapas aa jaate hain, aur
  Form Pending list bhi WorkDrive se rebuild hoti hai. Run history, Candidates aur Form invites
  list **nahi** bachti. Wo bhi chahiye to: Starter plan + disk (`/var/data`) aur
  `DATABASE_PATH=/var/data/screener.db` (render.yaml me comment kiya hua hai).
- **512 MB RAM.** Isliye `FETCH_TABS=1` hai. Run OOM ho to `MAX_PARALLEL_RESUMES=2` kar do.

### Speed (200 resumes ek saath)

- Health check `/healthz` pe hai - bada run chalte hue bhi turant jawab deta hai, Render restart nahi karta.
- PDF text pdfium se nikalta hai (C library) - pehle se ~10-20x tez, server busy nahi hota.
- Saari Zoho/Sheets calls ek pooled `requests.Session` se jaati hain (`http_client.py`) -
  pehle har call naya TLS handshake karta tha, ab connection reuse hota hai.
- SQLite WAL mode + ek hi khuli connection (`storage.py`) - commits ~30x tez, kyunki pehle
  har commit disk fsync karta tha aur har call nayi connection kholta tha.
- JS/CSS gzip ho ke jaate hain aur ek saal cache hote hain (URL me `?v=<mtime>` lagta hai,
  to naya deploy turant dikhta hai): pehla page load 130 KB → 33 KB.
- Email fetch (Chrome) aur screening ek saath nahi chalte - 512 MB plan pe dono milke memory khatam kar dete the.

### Delete safety

File delete sirf tab hoti hai jab ye sab live re-check me true ho:
file hai (folder nahi), .pdf/.docx hai, naam + byte size same hai, usi folder me hai
jahan score hui, parent chain ROOT tak pahunchti hai, aur Recruit me same naam + size
ka attachment confirm hai. Koi bhi check fail → file rehti hai, reason log hota hai.
Emergency: `.env` me `WORKDRIVE_DELETE_ENABLED=false`.

### Token scopes

Delete aur exact Recruit field mapping ke liye token me ye scopes chahiye
(`python3 generate_refresh_token.py` yahi string dikhata hai):

```
WorkDrive.files.READ,WorkDrive.files.CREATE,WorkDrive.files.UPDATE,WorkDrive.files.DELETE,ZohoRecruit.modules.ALL,ZohoRecruit.settings.READ
```

Recruit me score fields banao (Candidates): `AI_Score` (Number), `Skill_Score` (Number),
`AI_Summary` (Multi Line). Naam alag ho to `config.py` → `RECRUIT_SCORE_FIELDS`.

---

## Notes / limitations

- Runs, results, JDs aur audit log `screener.db` (SQLite) me save hote hain - restart pe safe.
- Server restart mid-run ho to wo run "failed (interrupted)" mark hota hai; dobara
  **Screen resumes** dabao - Recruit upsert aur attachment dono idempotent hain.
- Jo resumes same JD pe pehle reject ho chuke hain wo skip hote hain (OpenAI cost bachane
  ke liye); **Re-screen all** tick karke dobara score karo.
- Scanned/image-only PDFs se text nahi nikalta (OCR nahi hai) - wo "Failed" dikhenge.
- Single-user local tool hai: login/auth nahi hai, team ke liye deploy karne se pehle
  auth lagana zaroori hai.

# internal


## Fetching Indeed resumes from a computer (fetch_to_site.py)

Indeed shows the Render server a "Just a moment..." bot check, so the website's
**Fetch new from Gmail** can't download Indeed resumes. Run the fetch on any
office computer instead; it sends each resume to the website, which files it in
WorkDrive (`<position> / <date>`) and lists it under Applicants:

```
pip install -r requirements.txt
playwright install chromium
python fetch_to_site.py            # new application mails of the last 7 days
python fetch_to_site.py --days 30  # look further back
python fetch_to_site.py --limit 5  # quick test
```

Needs `EMAIL_APP_PASSWORD` in `.env`. Safe to re-run: mails already on the
website are skipped, and each saved resume's mail is marked read in Gmail.

### Sending email (Google Form, bulk email)

Render's free plan blocks outgoing SMTP (since Sept 2025), so on Render the
website **queues** emails and the same helper sends them from Gmail with the
App Password: `python fetch_to_site.py` (fetch + send) or `--send-only`.
Invites already in Gmail's Sent folder are never sent twice. On a paid Render
instance set `MAIL_VIA=smtp` and the website sends directly again.
