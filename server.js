import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import nodemailer from 'nodemailer';
import Airtable from 'airtable';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';

const {
  PORT = 8080,
  HOST = '0.0.0.0',

  // Airtable (base + tables)
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  AIRTABLE_APPS_TABLE = 'Applications',
  AIRTABLE_APPLICANTS_TABLE_ID,          // Table A (Applicants)
  AIRTABLE_UNDERWRITERS_TABLE_ID,        // Table B (Underwriters/Categories)
  APPLICANTS_EMAIL_FIELD = 'Email',
  APPLICANTS_CLASS_FIELD = 'Class of Business',
  UW_CLASS_FIELD = 'class',
  UW_EMAIL_FIELD = 'submission email',

  // Email
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
  SPACES_SECRET
} = process.env;

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}
[
  'AIRTABLE_PAT',
  'AIRTABLE_BASE_ID',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SPACES_ENDPOINT',
  'SPACES_BUCKET',
  'SPACES_KEY',
  'SPACES_SECRET'
].forEach(requireEnv);

const baseAT = new Airtable({ apiKey: AIRTABLE_PAT }).base(AIRTABLE_BASE_ID);

const s3 = new S3Client({
  region: SPACES_REGION,
  endpoint: `https://${SPACES_ENDPOINT}`,
  forcePathStyle: false,
  credentials: {
    accessKeyId: SPACES_KEY,
    secretAccessKey: SPACES_SECRET
  }
});

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
  tls: { rejectUnauthorized: true }
});

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ].includes(file.mimetype);
    if (!ok) return cb(new Error('Only PDF/DOC/DOCX files are allowed'));
    cb(null, true);
  }
});

function yyyymm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function safeName(name) {
  return name.replace(/[^\w.\-()+ ]+/g, '_');
}
function escapeForAirtableFormulaDoubleQuotes(s = '') {
  return s.replace(/"/g, '\\"');
}

// ---- Airtable helpers ----
async function airtableFindOne(tableIdOrName, filterByFormula) {
  const page = await baseAT(tableIdOrName)
    .select({ maxRecords: 1, filterByFormula })
    .firstPage();
  return page[0] || null;
}
async function airtableFindAll(tableIdOrName, filterByFormula) {
  const out = [];
  await baseAT(tableIdOrName)
    .select({ filterByFormula })
    .eachPage((records, next) => {
      out.push(...records);
      next();
    });
  return out;
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.post('/upload', upload.single('applicationFile'), async (req, res) => {
  try {
    const { classOfBusiness, moreInfo, submitterEmail } = req.body;
    const file = req.file;

    if (!submitterEmail) return res.status(400).send('Missing submitter email');
    if (!file) return res.status(400).send('No file uploaded');

    // Resolve effective class: prefer form value; else look up in Applicants (Table A) by email
    let effectiveClass = (classOfBusiness || '').trim();
    if (!effectiveClass && AIRTABLE_APPLICANTS_TABLE_ID) {
      const rec = await airtableFindOne(
        AIRTABLE_APPLICANTS_TABLE_ID,
        `LOWER({${APPLICANTS_EMAIL_FIELD}}) = LOWER("${escapeForAirtableFormulaDoubleQuotes(submitterEmail)}")`
      );
      if (rec) {
        const v = rec.get(APPLICANTS_CLASS_FIELD);
        if (v) effectiveClass = v.toString().trim();
      }
    }

    // Upload to Spaces
    const key = `applications/${yyyymm()}/${crypto.randomUUID()}-${safeName(file.originalname)}`;
    const put = new PutObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: 'public-read'
    });
    await s3.send(put);
    const publicUrl = `https://${SPACES_BUCKET}.${SPACES_ENDPOINT}/${key}`;

    // Create Applications record
    await baseAT(AIRTABLE_APPS_TABLE).create([
      {
        fields: {
          'Submitted By Email': submitterEmail || '',
          'Class of Business': effectiveClass || '',
          'More Information': moreInfo || '',
          'Uploaded File': [{ url: publicUrl, filename: file.originalname }]
        }
      }
    ]);

    // Find underwriter recipients by class (Table B)
    let matchedRecipients = [];
    if (effectiveClass && AIRTABLE_UNDERWRITERS_TABLE_ID) {
      const uwRecords = await airtableFindAll(
        AIRTABLE_UNDERWRITERS_TABLE_ID,
        `{${UW_CLASS_FIELD}} = "${escapeForAirtableFormulaDoubleQuotes(effectiveClass)}"`
      );
      const emails = uwRecords.flatMap(r => {
        const v = r.get(UW_EMAIL_FIELD);
        if (!v) return [];
        if (Array.isArray(v)) return v;            // multi-value
        return v.toString().split(',');            // allow comma-separated
      });
      matchedRecipients = [...new Set(emails.map(e => e.toString().trim()).filter(Boolean))];
    }

    // Optional override for testing
    const notifyList = OVERRIDE_NOTIFICATION_EMAIL
      ? [OVERRIDE_NOTIFICATION_EMAIL]
      : matchedRecipients;

    if (!notifyList.length) {
      return res.status(200).send('Uploaded and saved. No matching underwriters found.');
    }

    const html = `
      <p><strong>New application received</strong></p>
      <p><strong>Submitted By:</strong> ${submitterEmail}</p>
      <p><strong>Class of Business:</strong> ${effectiveClass || '(not provided)'}</p>
      <p><strong>More Information:</strong><br>${(moreInfo || 'None provided').replace(/\n/g, '<br>')}</p>
      <p><strong>File:</strong> <a href="${publicUrl}">${safeName(file.originalname)}</a></p>
    `;

    const subject = `New Application: ${effectiveClass || 'Unspecified Class'}`;
    await Promise.all(
      notifyList.map(to =>
        transporter.sendMail({
          from: SMTP_FROM,
          to,
          subject,
          html
        })
      )
    );

    res.status(200).send('Application submitted and notifications sent!');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

app.listen(Number(PORT), HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
