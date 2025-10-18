import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import Airtable from 'airtable';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

// ===== Env =====
const {
  PORT = 8080,
  HOST = '0.0.0.0',

  // Airtable (base + tables)
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  AIRTABLE_APPS_TABLE,                         // DEST table (submissions) – no default
  AIRTABLE_APPLICANTS_TABLE_ID,               // Table A (Applicants)
  AIRTABLE_UNDERWRITERS_TABLE_ID,             // Table B (Underwriters/Categories)
  APPLICANTS_EMAIL_FIELD = 'Email',
  APPLICANTS_CLASS_FIELD = 'Class of Business',
  UW_CLASS_FIELD = 'class',
  UW_EMAIL_FIELD = 'submission email',

  // Email (Brevo API preferred, SMTP fallback)
  BREVO_API_KEY,
  SMTP_HOST = 'smtp-relay.brevo.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  OVERRIDE_NOTIFICATION_EMAIL,

  // Spaces (S3)
  SPACES_ENDPOINT,
  SPACES_REGION = 'us-east-1',
  SPACES_BUCKET,
  SPACES_KEY,
  SPACES_SECRET,

  // Submissions table field overrides (use exact Airtable column names)
  APPS_EMAIL_FIELD,                           // default 'Email'
  APPS_CLASS_FIELD,                           // default 'Class of Business'
  APPS_NOTES_FIELD,                           // default 'More Information'
  APPS_FILE_FIELD                             // default 'Uploaded File'
} = process.env;

// === print what the app sees at runtime ===
console.log('AIRTABLE_APPS_TABLE =', AIRTABLE_APPS_TABLE);

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

// Required for core functionality
['AIRTABLE_PAT','AIRTABLE_BASE_ID','SMTP_FROM','SPACES_ENDPOINT','SPACES_BUCKET','SPACES_KEY','SPACES_SECRET','AIRTABLE_APPS_TABLE'].forEach(requireEnv);

// Email credentials: require either Brevo API key OR SMTP user/pass
if (!BREVO_API_KEY) ['SMTP_USER','SMTP_PASS'].forEach(requireEnv);

// ===== Clients =====
const baseAT = new Airtable({ apiKey: AIRTABLE_PAT }).base(AIRTABLE_BASE_ID);

const s3 = new S3Client({
  region: SPACES_REGION,
  endpoint: `https://${SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }
});

const transporter = (!BREVO_API_KEY)
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: false,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: true }
    })
  : null;

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword'].includes(file.mimetype);
    if (!ok) return cb(new Error('Only PDF/DOC/DOCX files are allowed'));
    cb(null, true);
  }
});

function yyyymm(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function safeName(name){ return name.replace(/[^\w.\-()+ ]+/g,'_'); }
function escapeForAirtableFormulaDoubleQuotes(s=''){ return s.replace(/"/g,'\\"'); }

// ---- Airtable helpers ----
async function airtableFindOne(tableIdOrName, filterByFormula){
  const page = await baseAT(tableIdOrName).select({ maxRecords:1, filterByFormula }).firstPage();
  return page[0] || null;
}
async function airtableFindAll(tableIdOrName, filterByFormula){
  const out=[]; await baseAT(tableIdOrName).select({ filterByFormula }).eachPage((recs,next)=>{ out.push(...recs); next(); }); return out;
}
async function getOrCreateClassIdByName(name){
  if (!name) return null;
  const formula = `LOWER({Name}) = LOWER("${escapeForAirtableFormulaDoubleQuotes(name)}")`;
  const existing = await airtableFindOne(CLASS_TABLE_ID, formula);
  if (existing) return existing.id;
  const created = await baseAT(CLASS_TABLE_ID).create([{ fields: { Name: name } }]);
  return created[0].id;
}
// ---- Email helpers ----
async function sendEmailBrevo(toList, subject, html){
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY missing');
  const payload = { sender:{ email: process.env.SMTP_FROM }, to: toList.map(e=>({email:e})), subject, htmlContent: html };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:'POST', headers:{ 'api-key':apiKey, 'content-type':'application/json','accept':'application/json' }, body: JSON.stringify(payload)
  });
  if (!res.ok){ const text=await res.text(); throw new Error(`Brevo API failed: ${res.status} ${text}`); }
}
async function sendEmails(list, subject, html){
  if (process.env.BREVO_API_KEY) return sendEmailBrevo(list, subject, html);
  return Promise.all(list.map(to => transporter.sendMail({ from: SMTP_FROM, to, subject, html })));
}

// ---- Routes ----
app.get('/healthz', (req,res)=>res.status(200).send('ok'));

app.post('/upload', upload.single('applicationFile'), async (req,res)=>{
  try{
    const { classOfBusiness, moreInfo, submitterEmail } = req.body;
    const file = req.file;
    if (!submitterEmail) return res.status(400).send('Missing submitter email');
    if (!file) return res.status(400).send('No file uploaded');

    // Resolve class via Applicants table if needed
    let effectiveClass = (classOfBusiness || '').trim();
    if (!effectiveClass && AIRTABLE_APPLICANTS_TABLE_ID){
      const rec = await airtableFindOne(
        AIRTABLE_APPLICANTS_TABLE_ID,
        `LOWER({${APPLICANTS_EMAIL_FIELD}}) = LOWER("${escapeForAirtableFormulaDoubleQuotes(submitterEmail)}")`
      );
      if (rec){
        const v = rec.get(APPLICANTS_CLASS_FIELD);
        if (v) effectiveClass = v.toString().trim();
      }
    }

    // Upload to Spaces
    const key = `applications/${yyyymm()}/${crypto.randomUUID()}-${safeName(file.originalname)}`;
    await s3.send(new PutObjectCommand({ Bucket: SPACES_BUCKET, Key: key, Body: file.buffer, ContentType: file.mimetype, ACL:'public-read' }));
    const publicUrl = `https://${SPACES_BUCKET}.${SPACES_ENDPOINT}/${key}`;

    // Create Submissions record (configurable field names)
    const CLASS_TABLE_ID = 'tblQ2rxDjTA1yMtxQ';
    const EMAIL_F = process.env.APPS_EMAIL_FIELD || 'Email';
    const CLASS_F = process.env.APPS_CLASS_FIELD || 'Class of Business';
    const NOTES_F = process.env.APPS_NOTES_FIELD || 'More Information';
    const FILE_F  = process.env.APPS_FILE_FIELD  || 'Uploaded File';

    console.log('Writing to table:', AIRTABLE_APPS_TABLE, { EMAIL_F, CLASS_F, NOTES_F, FILE_F });
    let classLink = [];
  if (effectiveClass){
  const classId = await getOrCreateClassIdByName(effectiveClass);
  if (classId) classLink = [{ id: classId }];
}
    await baseAT(AIRTABLE_APPS_TABLE).create([{
      fields: {
        [EMAIL_F]: submitterEmail || '',
        [CLASS_F]: classLink, // <-- linked record expects [{ id: 'rec...' }]
        [NOTES_F]: moreInfo || '',
        [FILE_F]: [{ url: publicUrl, filename: file.originalname }]
      }
    }]);

    // Underwriter match + email
    let matchedRecipients = [];
    if (effectiveClass && AIRTABLE_UNDERWRITERS_TABLE_ID){
      const uwRecords = await airtableFindAll(
        AIRTABLE_UNDERWRITERS_TABLE_ID,
        `{${UW_CLASS_FIELD}} = "${escapeForAirtableFormulaDoubleQuotes(effectiveClass)}"`
      );
      const emails = uwRecords.flatMap(r=>{
        const v = r.get(UW_EMAIL_FIELD);
        if (!v) return [];
        return Array.isArray(v) ? v : v.toString().split(',');
      });
      matchedRecipients = [...new Set(emails.map(e=>e.toString().trim()).filter(Boolean))];
    }

    const notifyList = OVERRIDE_NOTIFICATION_EMAIL ? [OVERRIDE_NOTIFICATION_EMAIL] : matchedRecipients;
    if (!notifyList.length) return res.status(200).send('Uploaded and saved. No matching underwriters found.');

    const html = `
      <p><strong>New application received</strong></p>
      <p><strong>Submitted By:</strong> ${submitterEmail}</p>
      <p><strong>Class of Business:</strong> ${effectiveClass || '(not provided)'}</p>
      <p><strong>More Information:</strong><br>${(moreInfo || 'None provided').replace(/\n/g,'<br>')}</p>
      <p><strong>File:</strong> <a href="${publicUrl}">${safeName(file.originalname)}</a></p>
    `;
    const subject = `New Application: ${effectiveClass || 'Unspecified Class'}`;
    await sendEmails(notifyList, subject, html);

    res.status(200).send('Application submitted and notifications sent!');
  }catch(err){
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('*', (req,res)=>{ res.sendFile(path.join(process.cwd(), 'public', 'index.html')); });

app.listen(Number(PORT), HOST, ()=>{ console.log(`Server running at http://${HOST}:${PORT}`); });
