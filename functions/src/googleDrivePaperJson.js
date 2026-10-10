import { safeErrorSummary } from './googleDrivePaperImportCore.js';

const DRIVE_ROOT_ENV = 'GOOGLE_DRIVE_PAPERS_ROOT_ID';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_JSON_BYTES = 8 * 1024 * 1024;
let tokenCache = { token: '', expiresAt: 0 };

const normalizeFolderName = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const driveError = (response) => {
  const error = new Error(`Google Drive API request failed with HTTP ${response.status}.`);
  error.status = response.status;
  return error;
};

const getRuntimeDriveToken = async () => {
  if (tokenCache.token && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const metadataUrl = new URL('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  metadataUrl.searchParams.set('scopes', DRIVE_SCOPE);
  const response = await fetch(metadataUrl, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!response.ok) {
    throw new Error('Could not obtain a Google Drive token from the function runtime identity. Confirm the function has a runtime service account.');
  }
  const data = await response.json();
  if (!data.access_token) throw new Error('The function runtime identity returned no Google Drive access token.');
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
};

const driveFetch = async (url, { method = 'GET', body, headers = {} } = {}) => {
  const token = await getRuntimeDriveToken();
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    ...(body === undefined ? {} : { body }),
  });
  if (!response.ok) throw driveError(response);
  return response;
};

const driveJson = async (url, options) => (await driveFetch(url, {
  ...options,
  headers: { Accept: 'application/json', ...(options?.headers ?? {}) },
})).json();

const getDriveFolder = async (folderId) => {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,trashed,parents');
  url.searchParams.set('supportsAllDrives', 'true');
  return driveJson(url);
};

const listDriveFolderChildren = async (folderId) => {
  const files = [];
  let pageToken = '';
  do {
    const url = new URL(`${DRIVE_API_BASE}/files`);
    url.searchParams.set('q', `'${String(folderId).replaceAll("'", "\\'")}' in parents and trashed = false`);
    url.searchParams.set('pageSize', '1000');
    url.searchParams.set('orderBy', 'name');
    url.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,version,size,md5Checksum,parents,trashed)');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('includeItemsFromAllDrives', 'true');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const page = await driveJson(url);
    files.push(...(page.files ?? []).filter((file) => !file.trashed));
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return files;
};

const configuredRoot = () => {
  const rootId = String(process.env[DRIVE_ROOT_ENV] ?? '').trim();
  if (!rootId) throw new Error(`Google Drive JSON support is not configured: set ${DRIVE_ROOT_ENV} to the specific past-papers root folder ID.`);
  return rootId;
};

export const findDrivePastPaperGradeFolder = async ({ subject, grade } = {}) => {
  const subjectName = String(subject ?? '').trim();
  const gradeName = String(grade ?? '').trim();
  if (!subjectName || !gradeName || subjectName.includes('/') || gradeName.includes('/')) {
    throw new Error('A valid subject and grade are required to locate the Google Drive folder.');
  }

  const rootId = configuredRoot();
  let root;
  try {
    root = await getDriveFolder(rootId);
  } catch (error) {
    if ([403, 404].includes(error.status)) {
      throw new Error(`The configured Drive root is unavailable to the function runtime identity. Confirm folder sharing and ${DRIVE_ROOT_ENV}. (Drive HTTP ${error.status})`);
    }
    throw error;
  }
  if (root.trashed || root.mimeType !== DRIVE_FOLDER_MIME) {
    throw new Error(`${DRIVE_ROOT_ENV} must identify an available Google Drive folder.`);
  }

  const subjectKey = normalizeFolderName(subjectName);
  const subjectFolders = (await listDriveFolderChildren(root.id))
    .filter((file) => file.mimeType === DRIVE_FOLDER_MIME && normalizeFolderName(file.name) === subjectKey);
  if (subjectFolders.length > 1) throw new Error(`More than one subject folder named ${subjectName} exists directly under the configured Drive root.`);
  if (!subjectFolders.length) return null;

  const gradeKey = normalizeFolderName(gradeName);
  const gradeFolders = (await listDriveFolderChildren(subjectFolders[0].id))
    .filter((file) => file.mimeType === DRIVE_FOLDER_MIME && normalizeFolderName(file.name) === gradeKey);
  if (gradeFolders.length > 1) throw new Error(`More than one ${gradeName} folder exists under the ${subjectName} Drive folder.`);
  return gradeFolders.length ? { ...gradeFolders[0], subjectFolderId: subjectFolders[0].id, rootId } : null;
};

export const listDrivePastPaperGradeFolders = async () => {
  const rootId = configuredRoot();
  let root;
  try {
    root = await getDriveFolder(rootId);
  } catch (error) {
    if ([403, 404].includes(error.status)) {
      throw new Error(`The configured Drive root is unavailable to the function runtime identity. Confirm folder sharing and ${DRIVE_ROOT_ENV}. (Drive HTTP ${error.status})`);
    }
    throw error;
  }
  if (root.trashed || root.mimeType !== DRIVE_FOLDER_MIME) {
    throw new Error(`${DRIVE_ROOT_ENV} must identify an available Google Drive folder.`);
  }

  const subjectFolders = (await listDriveFolderChildren(root.id))
    .filter((file) => file.mimeType === DRIVE_FOLDER_MIME);
  const gradeFolders = [];
  for (const subjectFolder of subjectFolders) {
    const children = await listDriveFolderChildren(subjectFolder.id);
    children.filter((file) => file.mimeType === DRIVE_FOLDER_MIME).forEach((gradeFolder) => {
      gradeFolders.push({
        subject: subjectFolder.name,
        grade: gradeFolder.name,
        id: gradeFolder.id,
        name: gradeFolder.name,
        subjectFolderId: subjectFolder.id,
        rootId: root.id,
      });
    });
  }
  return gradeFolders;
};

export const listDriveJsonFilesInGradeFolder = async (folderId) => (await listDriveFolderChildren(folderId))
  .filter((file) => file.mimeType !== DRIVE_FOLDER_MIME && String(file.name ?? '').toLowerCase().endsWith('.json'));

export const downloadDriveJsonFile = async (fileId, { maxBytes = MAX_JSON_BYTES } = {}) => {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set('alt', 'media');
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await driveFetch(url, { headers: { Accept: 'application/json' } });
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) throw new Error(`The Drive JSON file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit.`);
  if (!response.body) throw new Error('Google Drive returned an empty JSON response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`The Drive JSON file exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
};

const findUniqueNamedJsonFile = async (folderId, fileName) => {
  const expectedName = String(fileName ?? '').trim().toLocaleLowerCase();
  const matches = (await listDriveJsonFilesInGradeFolder(folderId))
    .filter((file) => String(file.name ?? '').trim().toLocaleLowerCase() === expectedName);
  if (matches.length > 1) {
    const error = new Error(`More than one ${fileName} file exists in the selected Drive grade folder.`);
    error.code = 'ambiguous';
    throw error;
  }
  return matches[0] ?? null;
};

export const readDriveQuestionPaperAnalysisJson = async (paper) => {
  const folder = await findDrivePastPaperGradeFolder({ subject: paper?.subject, grade: paper?.grade });
  if (!folder) return { found: false, reason: 'grade_folder_not_found' };
  const originalFileName = String(paper?.paperFileName ?? '').trim();
  if (!originalFileName || !/\.pdf$/i.test(originalFileName)) return { found: false, reason: 'paper_filename_unavailable' };
  const expectedName = originalFileName.replace(/\.pdf$/i, '.json');
  const file = await findUniqueNamedJsonFile(folder.id, expectedName);
  if (!file) return { found: false, reason: 'analysis_json_not_found', folderId: folder.id, expectedName };
  const text = await downloadDriveJsonFile(file.id);
  return { found: true, file, text, folderId: folder.id };
};

const writeJsonFile = async ({ folderId, existingFile, fileName, document }) => {
  const content = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (content.byteLength > MAX_JSON_BYTES) throw new Error('The topics.json output exceeds the Drive JSON size limit.');
  if (existingFile) {
    const url = new URL(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(existingFile.id)}`);
    url.searchParams.set('uploadType', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,version,size,md5Checksum');
    return driveJson(url, {
      method: 'PATCH',
      body: content,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    });
  }

  const boundary = `examifying_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = Buffer.from(JSON.stringify({ name: fileName, mimeType: 'application/json', parents: [folderId] }), 'utf8');
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const url = new URL(`${DRIVE_UPLOAD_BASE}/files`);
  url.searchParams.set('uploadType', 'multipart');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('fields', 'id,name,mimeType,modifiedTime,version,size,md5Checksum');
  return driveJson(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
  });
};

export const writeDriveTopicsJson = async ({ subject, grade, document, folder: knownFolder = null } = {}) => {
  const folder = knownFolder ?? await findDrivePastPaperGradeFolder({ subject, grade });
  if (!folder) throw new Error(`No ${grade} folder for ${subject} was found under the configured past-papers Drive root.`);
  const existingFile = await findUniqueNamedJsonFile(folder.id, 'topics.json');
  const savedFile = await writeJsonFile({ folderId: folder.id, existingFile, fileName: 'topics.json', document });
  return { folderId: folder.id, file: savedFile };
};

export const summarizeDriveJsonError = (error) => safeErrorSummary(error);
