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
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  AIRTABLE_APPS_TABLE = 'Applications',
  AIRTABLE_UW_TABLE = 'Underwriters',
  SMTP_HOST = 'smtp-relay.brevo.com',
  SMTP_PORT = '587',
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
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
['AIRTABLE_PAT','AIRTABLE_BASE_ID','SMTP_USER','SMTP_PASS','SMTP_FROM','SPACES_ENDPOINT','SPACES_BUCKET','SPACES_KEY','SPACES_SECRET'].forEach(requireEnv);

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
    const ok = ['application/pdf',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/msword'].includes(file.mimetype);
    if (!ok) return cb(new Error('Only PDF/DOC/DOCX files are allowed'));
    cb(null, true);
  }
});

function yyyymm() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function safeName(name) {
  return name.replace(/[^\w.\-()+ ]+/g, '_');
}
function escapeAirtableSingleQuotes(s) {
  return s.replace(/'/g, "''");
}

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.post('/upload', upload.single('applicationFile'), async (req, res) => {
  try {
    const { classOfBusiness, moreInfo } = req.body;
    const file = req.file;

    if (!classOfBusiness) return res.status(400).send('Missing classOfBusiness');
    if (!file) return res.status(400).send('No file uploaded');

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

    const created = await baseAT(AIRTABLE_APPS_TABLE).create([{
      fields: {
        'Class of Business': classOfBusiness,
        'More Information': moreInfo || '',
        'Uploaded File': [{ url: publicUrl, filename: file.originalname }]
      }
    }]);

    const safe = escapeAirtableSingleQuotes(classOfBusiness);
    const filterByFormula = `FIND(',' & '${safe}' & ',', ',' & ARRAYJOIN({Underwriter Classes}, ',') & ',')`;
    const underwriters = await baseAT(AIRTABLE_UW_TABLE).select({ filterByFormula }).all();

    if (underwriters.length === 0) {
      return res.status(200).send('Uploaded and saved. No matching underwriters found.');
    }

    const html = `
      <p><strong>New application received</strong></p>
      <p><strong>Class of Business:</strong> ${classOfBusiness}</p>
      <p><strong>More Information:</strong><br>${(moreInfo || 'None provided').replace(/\n/g,'<br>')}</p>
      <p><strong>File:</strong> <a href="${publicUrl}">${safeName(file.originalname)}</a></p>
    `;

    const sends = underwriters
      .map(r => r.get('Email'))
      .filter(Boolean)
      .map(to => transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject: `New Application: ${classOfBusiness}`,
        html
      }));

    await Promise.all(sends);
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
