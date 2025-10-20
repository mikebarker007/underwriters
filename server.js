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
  AIRTABLE_APPS_TABLE,
  AIRTABLE_APPLICANTS_TABLE_ID,
  AIRTABLE_UNDERWRITERS_TABLE_ID,
  AIRTABLE_CLASSES_TABLE_ID,
  APPLICANTS_EMAIL_FIELD = 'Email',
  APPLICANTS_CLASS_FIELD = 'Class of Business',
  UW_CLASS_FIELD = 'class',
  UW_EMAIL_FIELD = 'submission email',

  // Email
  BREVO_API_KEY,
  SMTP_HOST = 'smtp-relay.brevo.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  OVERRIDE_NOTIFICATION_EMAIL,

  // Spaces
  SPACES_ENDPOINT,
  SPACES_REGION = 'us-east-1',
  SPACES_BUCKET,
  SPACES_KEY,
  SPACES_SECRET,

  // Field overrides
  APPS_EMAIL_FIELD,
  APPS_CLASS_FIELD,
  APPS_NOTES_FIELD,
  APPS_FILE_FIELD
} = process.env;

const CLASS_TABLE_ID = AIRTABLE_CLASSES_TABLE_ID || 'tblQ2rxDjTA1yMtxQ';
console.log('AIRTABLE_APPS_TABLE =', AIRTABLE_APPS_TABLE);

// ---- helpers ----
function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
['AIRTABLE_PAT','AIRTABLE_BASE_ID','SMTP_FROM','SPACES_ENDPOINT','SPACES_BUCKET','SPACES_KEY','SPACES_SECRET','AIRTABLE_APPS_TABLE'].forEach(requireEnv);
if (!BREVO_API_KEY) ['SMTP_USER','SMTP_PASS'].forEach(requireEnv);

const baseAT = new Airtable({ apiKey: AIRTABLE_PAT }).base(AIRTABLE_BASE_ID);
const s3 = new S3Client({
  region: SPACES_REGION,
  endpoint: `https://${SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: { accessKeyId: SPACES_KEY, secretAccessKey: SPACES_SECRET }
});
const transporter = (!BREVO_API_KEY)
  ? nodemailer.createTransport({
      host: SMTP_HOST, port: Number(SMTP_PORT),
      secure: false, auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: true }
    }) : null;

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
async function airtableFindOne(tableId, formula){
  const page = await baseAT(tableId).select({ maxRecords:1, filterByFormula: formula }).firstPage();
  return page[0] || null;
}
async function airtableFindAll(tableId, formula){
  const out=[]; await baseAT(tableId).select({ filterByFormula: formula }).eachPage((recs,next)=>{ out.push(...recs); next(); });
  return out;
}
async function getOrCreateClassIdByName(name){
  if (!name) return null;
  const f = `LOWER({Name}) = LOWER("${escapeForAirtableFormulaDoubleQuotes(name)}")`;
  const existing = await airtableFindOne(CLASS_TABLE_ID, f);
  if (existing) return existing.id;
  const created = await baseAT(CLASS_TABLE_ID).create([{ fields: { Name: name } }]);
  return created[0].id;
}
async function findSubmissionByEmail(tableId, emailField, email){
  const formula = `LOWER({${emailField}}) = LOWER("${escapeForAirtableFormulaDoubleQuotes(email)}")`;
  return airtableFindOne(tableId, formula);
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
  if (process.env.BREVO_API_KEY) {
    try { return await sendEmailBrevo(list, subject, html); }
    catch (err) {
      console.error('Brevo send failed, will try SMTP if available:', err?.message || err);
      if (transporter)
        return Promise.all(list.map(to => transporter.sendMail({ from: SMTP_FROM, to, subject, html })));
      throw err;
    }
  }
  return Promise.all(list.map(to => transporter.sendMail({ from: SMTP_FROM, to, subject, html })));
}

// ---- Routes ----
app.get('/healthz',(req,res)=>res.status(200).send('ok'));

app.post('/upload', upload.single('applicationFile'), async (req,res)=>{
  try {
    const { classOfBusiness, moreInfo, submitterEmail } = req.body;
    const file = req.file;
    if (!submitterEmail) return res.status(400).send('Missing submitter email');
    if (!file) return res.status(400).send('No file uploaded');

    // resolve class
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

    // upload to Spaces
    const key = `applications/${yyyymm()}/${crypto.randomUUID()}-${safeName(file.originalname)}`;
    await s3.send(new PutObjectCommand({ Bucket: SPACES_BUCKET, Key: key, Body: file.buffer, ContentType: file.mimetype, ACL:'public-read' }));
    const publicUrl = `https://${SPACES_BUCKET}.${SPACES_ENDPOINT}/${key}`;

    // fields
    const EMAIL_F = process.env.APPS_EMAIL_FIELD || 'Email';
    const CLASS_F = process.env.APPS_CLASS_FIELD || 'Class of Business';
    const NOTES_F = process.env.APPS_NOTES_FIELD || 'More Information';
    const FILE_F  = process.env.APPS_FILE_FIELD  || 'Uploaded File';

    // resolve linked class
    let classLink=[], classRecordId=null, classDisplayName=(effectiveClass||'').trim();
    if (effectiveClass){
      if (/^rec[0-9A-Za-z]{14}$/.test(effectiveClass)) classRecordId=effectiveClass;
      else classRecordId=await getOrCreateClassIdByName(effectiveClass);
      if (classRecordId){
        classLink=[classRecordId];
        try{
          const clsRec=await baseAT(CLASS_TABLE_ID).find(classRecordId);
          const n=clsRec?.get('Name'); if(n) classDisplayName=n.toString();
        }catch(e){ console.error('Could not fetch class name',e?.message||e); }
      }
    }

    // UPSERT by email
    const existing = await findSubmissionByEmail(AIRTABLE_APPS_TABLE, EMAIL_F, submitterEmail);
    if (existing) {
      const existingFiles = Array.isArray(existing.get(FILE_F)) ? existing.get(FILE_F) : [];
      const newFiles = [...existingFiles, { url: publicUrl, filename: file.originalname }];
      const existingNotes = (existing.get(NOTES_F) || '').toString();
      const mergedNotes = (existingNotes && moreInfo)
        ? `${existingNotes}\n${moreInfo}` : (moreInfo || existingNotes || '');
      const updateFields = { [EMAIL_F]: submitterEmail, [NOTES_F]: mergedNotes, [FILE_F]: newFiles };
      if (classLink.length) updateFields[CLASS_F] = classLink;
      await baseAT(AIRTABLE_APPS_TABLE).update([{ id: existing.id, fields: updateFields }]);
    } else {
      await baseAT(AIRTABLE_APPS_TABLE).create([{ fields: {
        [EMAIL_F]: submitterEmail, [CLASS_F]: classLink,
        [NOTES_F]: moreInfo || '', [FILE_F]: [{ url: publicUrl, filename: file.originalname }]
      }}]);
    }

    // underwriter match
    let matchedRecipients=[];
    if ((classRecordId||classDisplayName)&&AIRTABLE_UNDERWRITERS_TABLE_ID){
      let uwRecords=[];
      if (classRecordId)
        uwRecords=await airtableFindAll(AIRTABLE_UNDERWRITERS_TABLE_ID,`FIND("${classRecordId}",ARRAYJOIN({${UW_CLASS_FIELD}}))>0`);
      if (!uwRecords.length&&classDisplayName)
        uwRecords=await airtableFindAll(AIRTABLE_UNDERWRITERS_TABLE_ID,`{${UW_CLASS_FIELD}}="${escapeForAirtableFormulaDoubleQuotes(classDisplayName)}"`);
      const emails=uwRecords.flatMap(r=>{
        const v=r.get(UW_EMAIL_FIELD);
        if(!v)return[]; return Array.isArray(v)?v:v.toString().split(',');
      });
      matchedRecipients=[...new Set(emails.map(e=>e.toString().trim()).filter(Boolean))];
    }

    const notifyList=OVERRIDE_NOTIFICATION_EMAIL?[OVERRIDE_NOTIFICATION_EMAIL]:matchedRecipients;
    const html=`<p><strong>New application received</strong></p>
<p><strong>Submitted By:</strong> ${submitterEmail}</p>
<p><strong>Class of Business:</strong> ${classDisplayName||'(not provided)'}</p>
<p><strong>More Information:</strong><br>${(moreInfo||'None provided').replace(/\n/g,'<br>')}</p>
<p><strong>File:</strong> <a href="${publicUrl}">${safeName(file.originalname)}</a></p>`;
    const subject=`New Application: ${classDisplayName||'Unspecified Class'}`;
    try{ if(notifyList.length) await sendEmails(notifyList,subject,html);}
    catch(e){ console.error('Notification error',e?.message||e); }

    res.status(200).send(existing
      ? 'Existing record updated and notifications sent.'
      : 'New record created and notifications sent.');
  } catch(err){ console.error(err); res.status(500).send('Server error'); }
});

app.get('*',(req,res)=>res.sendFile(path.join(process.cwd(),'public','index.html')));
app.listen(Number(PORT),HOST,()=>console.log(`Server running at http://${HOST}:${PORT}`));
