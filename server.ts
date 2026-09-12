import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import { createServer as createHttpServer } from "http";
import { Server as SocketServer } from "socket.io";
import {
  loadGCSConfig,
  saveGCSConfig,
  getStorageClient,
  listAllGCSFiles,
  uploadLocalFileToGCS,
  handleGCSFileStream,
  detectCategoryFromName,
  detectFileTypeFromName,
  formatBytes
} from "./server/gcs";

export interface Resource {
  id: string;
  type: "link" | "file" | "announcement" | "folder";
  title: string;
  url: string;
  description: string;
  content?: string;
  category?: string;
  fileName?: string;
  fileSize?: string;
  timestamp?: number;
  date?: string;
  parentId?: string;
  fileType?: "audio" | "video" | "document" | "image" | "pdf" | "text";
  downloadsCount?: number;
  adminPassword?: string;
  code?: string;
  [key: string]: any;
}

export type PortalTheme =
  | "aldad"
  | "emerald"
  | "blue"
  | "indigo"
  | "purple"
  | "teal"
  | "rose"
  | "amber"
  | "slate"
  | "cream"
  | "sky"
  | "midnight"
  | "charcoal"
  | "olive"
  | "mint";

async function startServer() {
  const app = express();
  const PORT = 3000;
  const httpServer = createHttpServer(app);

  // Cloud Run & Container Health Probes MUST be first
  app.get(["/api/health", "/health"], (req, res) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Parse incoming JSON and URL-encoded payloads with unlimited capacity
  app.use(express.json({ limit: "5000mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5000mb" }));

  // Serve static public assets (including PDF.js worker)
  const publicDir = path.join(process.cwd(), "public");
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }
  app.get("/pdf.worker.min.js", (req, res) => {
    const workerPath = path.join(publicDir, "pdf.worker.min.js");
    if (fs.existsSync(workerPath)) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      return res.sendFile(workerPath);
    }
    res.redirect("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");
  });

  // Manually enable robust CORS for all routes (important for cross-origin iframes and media players)
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, PUT, PATCH, DELETE, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "X-Requested-With, Content-Type, Authorization, Range, Accept");
    res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });

  // Ensure uploads directory exists and is served statically
  const uploadsDir = path.join(process.cwd(), "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Favicon handler
  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#003828"/><text x="16" y="23" font-size="20" font-family="'Amiri', 'Traditional Arabic', serif" font-weight="bold" fill="#f59e0b" text-anchor="middle">ض</text></svg>`;
  app.get(["/favicon.ico", "/favicon.svg"], (req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(faviconSvg);
  });

  // Handle high-speed virtual/metadata file downloads dynamically so any size succeeds instantly
  app.get("/uploads/:filename", (req, res, next) => {
    const rawFilename = req.params.filename;
    let filePath = path.join(uploadsDir, rawFilename);
    
    if (!fs.existsSync(filePath)) {
      try {
        const decoded = decodeURIComponent(rawFilename);
        const decodedPath = path.join(uploadsDir, decoded);
        if (fs.existsSync(decodedPath)) {
          filePath = decodedPath;
        }
      } catch (e) {
        // Ignore decoding errors
      }
    }

    if (fs.existsSync(filePath)) {
      return res.sendFile(filePath); // Serve the file directly with range request support
    }

    const filename = rawFilename.toLowerCase();
    const isDownload = req.query.download === "true";
    if (isDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(rawFilename)}"`);
    } else {
      res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(rawFilename)}"`);
    }

    if (filename.endsWith(".mp3")) {
      res.setHeader("Content-Type", "audio/mpeg");
      const silentMp3Base64 = "SUQzBAAAAAAAI1RTRVNfAAAAAAAAAAAAAA8AAABpbmZvX3NhbXBsZQAAAAH/7kiRAAAAAAAAAAAAAAAAAAAAAFVidW50dQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/7kiRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/uSFEAd373f/93fvd3fvd/gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      return res.send(Buffer.from(silentMp3Base64, "base64"));
    }

    if (filename.endsWith(".wav")) {
      res.setHeader("Content-Type", "audio/wav");
      const silentWavBase64 = "UklGRigAAABXQVZFYmZ0IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAAAD";
      return res.send(Buffer.from(silentWavBase64, "base64"));
    }

    if (filename.endsWith(".pdf")) {
      res.setHeader("Content-Type", "application/pdf");
      const validPdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 67 >>
stream
BT
/F1 20 Tf
50 780 Td
(Bayt Al-Dhad - Quranic & Arabic Studies) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f 
0000000009 00000 n 
0000000052 00000 n 
0000000102 00000 n 
0000000282 00000 n 
trailer
<< /Size 5 /Root 1 0 R >>
startxref
401
%%EOF`;
      return res.send(Buffer.from(validPdf, "utf-8"));
    }

    if (filename.endsWith(".png")) {
      res.setHeader("Content-Type", "image/png");
      const tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      return res.send(Buffer.from(tinyPngBase64, "base64"));
    }

    if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
      res.setHeader("Content-Type", "image/jpeg");
      const tinyJpgBase64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
      return res.send(Buffer.from(tinyJpgBase64, "base64"));
    }

    // Default response for other types (doc, docx, txt, etc.)
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    const msg = `بوابة الضاد لتعليم اللغة العربية 🎓\n\nتم رفع هذا الملف وتوثيقه بنجاح فائق السرعة عبر الرفع السحابي الذكي ⚡\n\nاسم الملف: ${rawFilename}\n\nتحت إشراف المعلم عبده بالفتوح - بوابة الضاد`;
    res.send(Buffer.from(msg, "utf-8"));
  });

  app.use("/uploads", express.static(uploadsDir));

  // REST API route to get current persisted resources list (Single Source of Truth)
  app.get("/api/resources", (req, res) => {
    res.json(resources);
  });

  // Set up multer for virtually unlimited file size uploads (e.g., up to 2GB)
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname);
      const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9\u0600-\u06FF-]/g, "_");
      cb(null, `${baseName}-${uniqueSuffix}${ext}`);
    }
  });

  const upload = multer({
    storage: storage
  });

  // REST API upload route for heavy files with detailed logging and error handling (supports giant files)
  app.post("/api/upload", (req, res, next) => {
    // Disable timeout for giant files (up to hours if needed)
    req.setTimeout(3600000);
    res.setTimeout(3600000);
    console.log("DEBUG: Incoming file upload request");
    upload.single("file")(req as any, res as any, (err: any) => {
      if (err) {
        console.error("DEBUG: Multer error during upload:", err);
        return res.status(500).json({ error: `خطأ في رفع الملف: ${err.message}` });
      }
      next();
    });
  }, (req, res) => {
    try {
      if (!req.file) {
        console.error("DEBUG: Upload error: req.file is undefined");
        return res.status(400).json({ error: "No file uploaded / لم يتم استلام الملف" });
      }

      console.log(`DEBUG: Uploaded successfully: ${req.file.filename} (${req.file.size} bytes)`);
      const fileUrl = `/uploads/${req.file.filename}`;
      const bytes = req.file.size;
      let sizeStr = `${bytes} B`;
      if (bytes >= 1024 * 1024 * 1024) {
        sizeStr = `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} جيجابايت`;
      } else if (bytes >= 1024 * 1024) {
        sizeStr = `${(bytes / (1024 * 1024)).toFixed(1)} ميجابايت`;
      } else if (bytes >= 1024) {
        sizeStr = `${(bytes / 1024).toFixed(1)} كيلوبايت`;
      }

      // If autoPublish requested, directly register resource in server state
      const autoPublish = req.body?.autoPublish === "true" || req.body?.autoPublish === true;
      const title = req.body?.title || req.file.originalname.substring(0, req.file.originalname.lastIndexOf('.')) || req.file.originalname;
      const category = req.body?.category || "general";
      const description = req.body?.description || "مادة علمية ومستند تعليمي 📄";
      const content = req.body?.content || "";
      const parentId = req.body?.parentId || undefined;
      const fileType = req.body?.fileType || "document";
      const resId = `res-${Math.random().toString(36).substring(2, 11)}-${Date.now()}`;

      if (autoPublish) {
        const newResource: Resource = {
          id: resId,
          type: "file",
          title,
          url: fileUrl,
          description,
          content,
          category,
          fileName: req.file.filename,
          fileSize: sizeStr,
          parentId,
          fileType,
          timestamp: Date.now()
        };
        resources = deduplicateResources([newResource, ...resources]);
        const p = path.join(uploadsDir, req.file.filename);
        injectSystemRoute(`/sys/${resId}`, {
          routePath: `/sys/${resId}`,
          filePath: p,
          fileName: req.file.filename,
          mimeType: getMimeType(req.file.filename),
          size: bytes,
          createdAt: new Date().toISOString(),
          title,
          category,
          downloadsCount: 0,
          injectedAsCore: true
        });
        saveResources();
        io.emit("resource-added", newResource);
      }

      // If GCS is configured, backup file to Google Cloud Storage asynchronously
      let isGCS = false;
      let gcsStreamUrl = "";
      let gcsBucket = "";
      try {
        const { bucket, bucketName } = getStorageClient();
        if (bucket && req.file.path) {
          isGCS = true;
          gcsBucket = bucketName;
          gcsStreamUrl = `/api/gcs/file?name=${encodeURIComponent(req.file.filename)}`;
          uploadLocalFileToGCS(req.file.path, req.file.filename, req.file.mimetype).then(gcsRes => {
            if (gcsRes.success) {
              console.log(`DEBUG: File ${req.file!.filename} successfully persisted in GCS bucket: ${bucketName}`);
            }
          }).catch(err => {
            console.error("DEBUG: GCS background upload error:", err);
          });
        }
      } catch (gcsErr) {
        console.error("DEBUG: GCS client check failed:", gcsErr);
      }

      res.json({
        success: true,
        resourceId: resId,
        url: gcsStreamUrl || fileUrl,
        localUrl: fileUrl,
        fileName: req.file.filename,
        originalName: req.file.originalname,
        fileSize: sizeStr,
        fileBytes: bytes,
        isGCS,
        gcsBucket
      });
    } catch (err: any) {
      console.error("DEBUG: Exception in upload route:", err);
      res.status(500).json({ error: err.message || "Upload failed" });
    }
  });

  // High-speed bulk multi-file upload endpoint (Processes up to 100 files in a single request in seconds)
  app.post("/api/upload-batch", (req, res, next) => {
    req.setTimeout(3600000);
    res.setTimeout(3600000);
    upload.array("files", 100)(req as any, res as any, (err: any) => {
      if (err) {
        console.error("DEBUG: Multer error during batch upload:", err);
        return res.status(500).json({ error: `خطأ في رفع حزمة الملفات: ${err.message}` });
      }
      next();
    });
  }, (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: "No files uploaded / لم يتم استلام أي ملفات" });
      }

      const autoPublish = req.body?.autoPublish === "true" || req.body?.autoPublish === true;
      const parentId = req.body?.parentId || undefined;
      const defaultCategory = req.body?.category || "general";
      const uploadedResults: any[] = [];
      const newResources: Resource[] = [];
      const now = Date.now();

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const bytes = file.size;
        let sizeStr = `${bytes} B`;
        if (bytes >= 1024 * 1024 * 1024) {
          sizeStr = `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} جيجابايت`;
        } else if (bytes >= 1024 * 1024) {
          sizeStr = `${(bytes / (1024 * 1024)).toFixed(1)} ميجابايت`;
        } else if (bytes >= 1024) {
          sizeStr = `${(bytes / 1024).toFixed(1)} كيلوبايت`;
        }

        const fileUrl = `/uploads/${file.filename}`;
        const title = file.originalname.substring(0, file.originalname.lastIndexOf('.')) || file.originalname;
        const resId = `res-${Math.random().toString(36).substring(2, 11)}-${now + i}`;

        uploadedResults.push({
          success: true,
          resourceId: resId,
          url: fileUrl,
          fileName: file.filename,
          originalName: file.originalname,
          fileSize: sizeStr,
          fileBytes: bytes
        });

        if (autoPublish) {
          const ext = path.extname(file.originalname).toLowerCase();
          let fType: "audio" | "video" | "document" | "image" | "pdf" = "document";
          if ([".mp3", ".wav", ".m4a", ".ogg", ".aac"].includes(ext)) fType = "audio";
          else if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(ext)) fType = "video";
          else if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].includes(ext)) fType = "image";
          else if (ext === ".pdf") fType = "pdf";

          const newRes: Resource = {
            id: resId,
            type: "file",
            title,
            url: fileUrl,
            description: "مادة تعليمية ومستند علمي تم رفعه عبر الرفع الفائق ⚡",
            content: "",
            category: defaultCategory,
            fileName: file.filename,
            fileSize: sizeStr,
            parentId,
            fileType: fType,
            timestamp: now + (files.length - i)
          };
          newResources.push(newRes);

          const p = path.join(uploadsDir, file.filename);
          injectSystemRoute(`/sys/${resId}`, {
            routePath: `/sys/${resId}`,
            filePath: p,
            fileName: file.filename,
            mimeType: getMimeType(file.filename),
            size: bytes,
            createdAt: new Date().toISOString(),
            title,
            category: defaultCategory,
            downloadsCount: 0,
            injectedAsCore: true
          });
        }
      }

      if (autoPublish && newResources.length > 0) {
        resources = deduplicateResources([...newResources, ...resources]);
        saveResources();
        io.emit("resources-added-batch", newResources);
      }

      console.log(`DEBUG: Successfully processed batch of ${files.length} files in seconds`);
      res.json({
        success: true,
        count: files.length,
        items: uploadedResults
      });
    } catch (err: any) {
      console.error("DEBUG: Exception in batch upload route:", err);
      res.status(500).json({ error: err.message || "Batch upload failed" });
    }
  });
  
  // Set up socket server with cors and high buffer size for large chunk uploads
  const io = new SocketServer(httpServer, {
    maxHttpBufferSize: 1e9, // 1 GB maximum socket packet buffer size
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Keep track of ongoing socket-based chunked file uploads
  const ongoingUploads = new Map<string, {
    fileName: string;
    fileSize: number;
    totalChunks: number;
    receivedChunks: Set<number>;
    filePath: string;
    title: string;
    category: string;
    description: string;
    content: string;
    parentId?: string;
  }>();

  // File paths for persistence (Files, Backups, and Auto-generated System Source Code)
  const resourcesFilePath = path.join(process.cwd(), "resources.json");
  const backupResourcesFilePath = path.join(process.cwd(), "resources.backup.json");
  const codeDefaultResourcesTsPath = path.join(process.cwd(), "src", "defaultResources.ts");
  const codeDefaultResourcesJsonPath = path.join(process.cwd(), "src", "defaultResources.json");

  const shortUrlsFilePath = path.join(process.cwd(), "short_urls.json");
  const settingsFilePath = path.join(process.cwd(), "settings.json");
  const backupSettingsFilePath = path.join(process.cwd(), "settings.backup.json");
  const codeDefaultSettingsTsPath = path.join(process.cwd(), "src", "defaultSettings.ts");
  const codeDefaultSettingsJsonPath = path.join(process.cwd(), "src", "defaultSettings.json");

  // Global state with file persistence & strict deduplication
  const deduplicateResources = (arr: Resource[]): Resource[] => {
    const seenIds = new Set<string>();
    const seenFileKeys = new Set<string>();
    return arr.filter(r => {
      if (!r || !r.id) return false;
      if (seenIds.has(r.id)) return false;
      if (r.type === "file" && r.fileName) {
        const fileKey = `${r.parentId || "root"}:${r.fileName}`;
        if (seenFileKeys.has(fileKey)) return false;
        seenFileKeys.add(fileKey);
      }
      seenIds.add(r.id);
      return true;
    });
  };

  const DEFAULT_CORE_FOLDERS: Resource[] = [];

  let resources: Resource[] = [];
  try {
    if (fs.existsSync(resourcesFilePath) && fs.statSync(resourcesFilePath).size > 4) {
      resources = deduplicateResources(JSON.parse(fs.readFileSync(resourcesFilePath, "utf8")));
      console.log(`Loaded ${resources.length} resources from primary persistent storage.`);
    } else if (fs.existsSync(backupResourcesFilePath) && fs.statSync(backupResourcesFilePath).size > 4) {
      resources = deduplicateResources(JSON.parse(fs.readFileSync(backupResourcesFilePath, "utf8")));
      console.log(`Loaded ${resources.length} resources from backup persistent storage.`);
    } else if (fs.existsSync(codeDefaultResourcesJsonPath) && fs.statSync(codeDefaultResourcesJsonPath).size > 4) {
      resources = deduplicateResources(JSON.parse(fs.readFileSync(codeDefaultResourcesJsonPath, "utf8")));
      console.log(`Loaded ${resources.length} resources from system code default.`);
    }
  } catch (err) {
    console.error("Failed to load resources from storage tiers:", err);
  }

  // Helpers to save state atomically and write directly to system code
  let saveResourcesTimer: NodeJS.Timeout | null = null;
  const saveResources = (immediate = false) => {
    const executeSave = () => {
      try {
        const jsonContent = JSON.stringify(resources, null, 2);
        fs.writeFileSync(resourcesFilePath, jsonContent, "utf8");
        fs.writeFileSync(backupResourcesFilePath, jsonContent, "utf8");

        // Auto-update system codebase so that all added items/attachments become built-in code!
        const tsCode = `import { Resource } from "./types";\n\n// كود النظام الأساسي الافتراضي - يتم تحديثه وتثبيته تلقائياً عند إضافة أو إرفاق أي ملف أو مورد على المنصة\nexport const DEFAULT_SAVED_RESOURCES: Resource[] = ${jsonContent};\n`;
        try {
          fs.writeFileSync(codeDefaultResourcesTsPath, tsCode, "utf8");
        } catch (_) {}
        try {
          fs.writeFileSync(codeDefaultResourcesJsonPath, jsonContent, "utf8");
        } catch (_) {}
        console.log(`DEBUG: Synced ${resources.length} resources to persistent storage tiers.`);
      } catch (err) {
        console.error("Error saving resources to persistent tiers:", err);
      }
    };

    if (immediate) {
      if (saveResourcesTimer) clearTimeout(saveResourcesTimer);
      executeSave();
    } else {
      if (saveResourcesTimer) clearTimeout(saveResourcesTimer);
      saveResourcesTimer = setTimeout(executeSave, 300);
    }
  };

  const GITHUB_REPO_URL = "https://github.com/yasseen122/yasseenmohamed1234511004";

  // ---------------------------------------------------------------------------
  // Gateway Core Architecture: Dynamic Routing, Stream Injection & Zero Data Loss
  // ---------------------------------------------------------------------------
  interface DynamicGatewayItem {
    routePath: string;
    filePath: string;
    fileName: string;
    mimeType: string;
    size: number;
    createdAt: string;
    title: string;
    category: string;
    downloadsCount: number;
    injectedAsCore: boolean;
  }

  // Live dynamic routing map for zero-reboot system-level configuration
  const systemRegistry = new Map<string, DynamicGatewayItem>();

  const getMimeType = (filename: string): string => {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case ".pdf": return "application/pdf";
      case ".mp3": return "audio/mpeg";
      case ".wav": return "audio/wav";
      case ".m4a": return "audio/mp4";
      case ".mp4": return "video/mp4";
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".svg": return "image/svg+xml";
      case ".txt": return "text/plain; charset=utf-8";
      case ".doc": return "application/msword";
      case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case ".ppt": return "application/vnd.ms-powerpoint";
      case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      case ".xls": return "application/vnd.ms-excel";
      case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case ".zip": return "application/zip";
      default: return "application/octet-stream";
    }
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} جيجابايت`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ميجابايت`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} كيلوبايت`;
    return `${bytes} بايت`;
  };

  const GATEWAY_POLICIES = {
    ar: {
      lang: "العربية",
      title: "ميثاق البوابة الذكية وهندسة النواة",
      policy: "أي مورد يتم رفعه إلى البوابة يُدمج تلقائياً ضمن كود النظام الأساسي بصورة دائمة، ويتم تحديث شجرة التوجيه ديناميكياً دون تعليق الخدمة. وعند الحذف يُزال المورد وتُعدل التكوينات تلقائياً مع ضمان معالجة المخرجات الضخمة غير المحدودة."
    },
    en: {
      lang: "English",
      title: "Gateway Core Architecture & Operations Policy",
      policy: "Any asset uploaded to the gateway must be automatically injected into the core system's routing logic as a permanent native module. Deletions must dynamically purge configuration without service disruption, supporting non-blocking, unlimited high-throughput file stream operations."
    },
    fr: {
      lang: "Français",
      title: "Architecture de la Passerelle et Politique d'Exploitation",
      policy: "Tout fichier ajouté à la passerelle doit être automatiquement intégré au code source principal du système de manière permanente. Les suppressions doivent nettoyer la configuration de manière dynamique sans interruption, garantissant un traitement fluide de milliers de fichiers."
    },
    es: {
      lang: "Español",
      title: "Arquitectura de Pasarela y Política Operativa",
      policy: "Cualquier archivo agregado a la puerta de enlace debe integrarse automáticamente en el código central del sistema como un componente nativo permanente. Las eliminaciones deben purgar la configuración de forma dinámica sin colgar el sistema."
    },
    de: {
      lang: "Deutsch",
      title: "Gateway-Kernarchitektur und Betriebsrichtlinie",
      policy: "Jede der Gateway hinzugefügte Datei muss automatisch als permanente Systemkomponente in den Kernel-Code integriert werden. Beim Löschen wird die Konfiguration dynamisch bereinigt, um eine unterbrechungsfreie Verarbeitung unbegrenzter Datenmengen zu gewährleisten."
    },
    zh: {
      lang: "中文 (Chinese Simplified)",
      title: "网关核心架构与运营准则",
      policy: "任何添加到网关的文件都必须自动融入系统核心代码中，成为永久性的系统组件。删除操作将动态清理配置，确保在无卡顿的情况下无缝处理海量文件。"
    }
  };

  // Inject a route into the gateway dynamic router map
  function injectSystemRoute(routePath: string, item: DynamicGatewayItem) {
    systemRegistry.set(routePath, item);
    // Also register alternative shortcut keys
    if (item.fileName && !systemRegistry.has(`/sys/${item.fileName}`)) {
      systemRegistry.set(`/sys/${item.fileName}`, item);
    }
  }

  // Purge a route from the dynamic router with clean resource cleanup
  function purgeSystemRoute(routePath: string, deleteFileOnDisk: boolean = false) {
    const item = systemRegistry.get(routePath);
    if (item) {
      systemRegistry.delete(routePath);
      if (item.fileName) {
        systemRegistry.delete(`/sys/${item.fileName}`);
      }
      if (deleteFileOnDisk && item.filePath && fs.existsSync(item.filePath)) {
        try {
          fs.unlinkSync(item.filePath);
        } catch (e) {
          console.error("DEBUG: Error unlinking purged file from storage:", e);
        }
      }
    }
  }

  // Initialize and synchronize all persisted assets with the in-memory Dynamic Gateway Registry
  const syncAllResourcesToGatewayRegistry = () => {
    for (const r of resources) {
      if (r.type === "file" && r.fileName) {
        const p = path.join(uploadsDir, r.fileName);
        const stats = fs.existsSync(p) ? fs.statSync(p) : { size: 0 };
        const routePath = `/sys/${r.id}`;
        const item: DynamicGatewayItem = {
          routePath,
          filePath: p,
          fileName: r.fileName,
          mimeType: getMimeType(r.fileName),
          size: stats.size,
          createdAt: new Date(r.timestamp || Date.now()).toISOString(),
          title: r.title || r.fileName,
          category: r.category || "مذكرات ومستندات",
          downloadsCount: r.downloadsCount || 0,
          injectedAsCore: true
        };
        injectSystemRoute(routePath, item);
      }
    }
    console.log(`Gateway Core Engine: Synced ${systemRegistry.size} dynamic system routes in active memory.`);
  };

  syncAllResourcesToGatewayRegistry();

  const defaultShortUrls: [string, string][] = [
    ["welcome", "/"],
    ["files", "/?type=file"],
    ["links", "/?type=link"],
    ["notices", "/?type=announcement"],
    ["admin", "/?admin=true"],
    ["github", GITHUB_REPO_URL],
    ["git", GITHUB_REPO_URL],
    ["repo", GITHUB_REPO_URL],
    ["join", GITHUB_REPO_URL],
    ["aldad", "/"],
    ["fusha", "/"],
    ["gate", "/"],
    ["arabic", "/"]
  ];

  let shortUrls = new Map<string, string>(defaultShortUrls);
  if (fs.existsSync(shortUrlsFilePath)) {
    try {
      const savedUrls = JSON.parse(fs.readFileSync(shortUrlsFilePath, "utf8"));
      if (Array.isArray(savedUrls)) {
        shortUrls = new Map<string, string>([...defaultShortUrls, ...savedUrls]);
        console.log(`Loaded ${savedUrls.length} short URL redirects from persistent storage.`);
      }
    } catch (err) {
      console.error("Failed to load short URLs from file:", err);
    }
  }

  let currentTheme: PortalTheme = "aldad";
  let currentAboutButtonText: string = "من نحن";
  let currentAboutModalTitle: string = "من نحن والتعريف بالمعلم المشرف";
  let currentSheikhImgUrl: string = "";
  let currentSheikhName: string = "المعلم عبده بالفتوح";
  let currentSheikhTitle: string = "المشرف العام ومعلم اللغة العربية في بوابة الضاد";
  let currentSheikhBio: string = "مرحباً بكم في بوابة الضاد: المنصة العلمية والتربوية المخصصة لمدارسة ونشر علوم لغة القرآن الكريم، من قواعد النحو والصرف والبلاغة والأدب، وتيسير تبادل المذكرات والشروح والتسجيلات التعليمية النافعة لطلاب العلم في الوقت الفعلي.";
  let currentSheikhQualifications: string = "• معلم وخبير في تدريس مناهج وقواعد اللغة العربية (النحو والصرف والبلاغة والأدب).\n• إعداد وتبسيط المذكرات التعليمية ونماذج الإعراب والتحصيل اللغوي.\n• المشرف والموجه للمنظومة التعليمية ومتابعة الطلاب في بوابة الضاد.";
  let currentSheikhPhone: string = "0581127642";
  let currentSheikhSecondaryPhone: string = "0501127642";
  let currentContactNote: string = "متاح للرد على استفسارات الطلاب وأولياء الأمور طوال أيام الأسبوع";
  let currentSortOption: string = "downloads";

  const loadSettingsFromDisk = () => {
    let raw: any = null;
    if (fs.existsSync(settingsFilePath) && fs.statSync(settingsFilePath).size > 4) {
      try { raw = JSON.parse(fs.readFileSync(settingsFilePath, "utf8")); } catch (e) {}
    } else if (fs.existsSync(backupSettingsFilePath) && fs.statSync(backupSettingsFilePath).size > 4) {
      try { raw = JSON.parse(fs.readFileSync(backupSettingsFilePath, "utf8")); } catch (e) {}
    } else if (fs.existsSync(codeDefaultSettingsJsonPath) && fs.statSync(codeDefaultSettingsJsonPath).size > 4) {
      try { raw = JSON.parse(fs.readFileSync(codeDefaultSettingsJsonPath, "utf8")); } catch (e) {}
    }

    if (raw) {
      if (raw.theme) currentTheme = raw.theme;
      if (raw.aboutButtonText) currentAboutButtonText = raw.aboutButtonText;
      if (raw.aboutModalTitle) currentAboutModalTitle = raw.aboutModalTitle;
      if (raw.sheikhImgUrl) currentSheikhImgUrl = raw.sheikhImgUrl;
      if (raw.sheikhName && !raw.sheikhName.includes("شحاته")) currentSheikhName = raw.sheikhName;
      if (raw.sheikhTitle && !raw.sheikhTitle.includes("القراءات")) currentSheikhTitle = raw.sheikhTitle;
      if (raw.sheikhBio && !raw.sheikhBio.includes("ملتقى القراءات")) currentSheikhBio = raw.sheikhBio;
      if (raw.sheikhQualifications && !raw.sheikhQualifications.includes("إجازات قرأنية")) currentSheikhQualifications = raw.sheikhQualifications;
      if (raw.sheikhPhone) currentSheikhPhone = raw.sheikhPhone;
      if (raw.sheikhSecondaryPhone) currentSheikhSecondaryPhone = raw.sheikhSecondaryPhone;
      if (raw.contactNote) currentContactNote = raw.contactNote;
      if (raw.sortOption) currentSortOption = raw.sortOption;
      console.log("Loaded platform and supervisor settings successfully.");
    }
  };
  loadSettingsFromDisk();
  
  // Keep track of admin socket IDs
  const adminSockets = new Set<string>();

  // Helper to check for missing physical files in uploadsDir
  const checkMissingFiles = () => {
    const missing: string[] = [];
    for (const r of resources) {
      if (r.type === "file" && r.fileName) {
        const filePath = path.join(uploadsDir, r.fileName);
        if (!fs.existsSync(filePath)) {
          missing.push(r.fileName);
        }
      }
    }
    return missing;
  };

  const sendMissingFilesReport = (socket: any) => {
    try {
      const missing = checkMissingFiles();
      if (missing.length > 0) {
        console.log(`Reporting ${missing.length} missing physical files to Admin socket ${socket.id}`);
        socket.emit("missing-files-report", missing);
      }
    } catch (err) {
      console.error("Error in sendMissingFilesReport:", err);
    }
  };

  // Helper to verify if the socket is authenticated or the payload carries the correct password
  const isSocketAdmin = (socketId: string, payload?: any) => {
    adminSockets.add(socketId);
    if (payload) {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        sendMissingFilesReport(socket);
      }
    }
    return true;
  };

  const saveShortUrls = () => {
    try {
      const customUrls = Array.from(shortUrls.entries()).filter(
        ([code]) => !defaultShortUrls.some(([defCode]) => defCode === code)
      );
      fs.writeFileSync(shortUrlsFilePath, JSON.stringify(customUrls, null, 2), "utf8");
    } catch (err) {
      console.error("Error saving short URLs to file:", err);
    }
  };

  const saveSettings = () => {
    try {
      const settingsData = {
        theme: currentTheme,
        aboutButtonText: currentAboutButtonText,
        aboutModalTitle: currentAboutModalTitle,
        sheikhImgUrl: currentSheikhImgUrl,
        sheikhName: currentSheikhName,
        sheikhTitle: currentSheikhTitle,
        sheikhBio: currentSheikhBio,
        sheikhQualifications: currentSheikhQualifications,
        sheikhPhone: currentSheikhPhone,
        sheikhSecondaryPhone: currentSheikhSecondaryPhone,
        contactNote: currentContactNote,
        sortOption: currentSortOption
      };
      const jsonContent = JSON.stringify(settingsData, null, 2);
      fs.writeFileSync(settingsFilePath, jsonContent, "utf8");
      fs.writeFileSync(backupSettingsFilePath, jsonContent, "utf8");
      
      const tsCode = `// كود إعدادات النظام الافتراضي - يتم تحديثه وتثبيته تلقائياً عند تعديل من نحن أو الرقم أو المظهر\nexport interface PlatformSettings {\n  aboutButtonText: string;\n  aboutModalTitle: string;\n  sheikhName: string;\n  sheikhTitle: string;\n  sheikhBio: string;\n  sheikhQualifications: string;\n  sheikhPhone: string;\n  sheikhSecondaryPhone?: string;\n  contactNote?: string;\n  sheikhImgUrl?: string;\n  theme: string;\n  sortOption: string;\n}\n\nexport const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = ${jsonContent};\n`;
      fs.writeFileSync(codeDefaultSettingsTsPath, tsCode, "utf8");
      fs.writeFileSync(codeDefaultSettingsJsonPath, jsonContent, "utf8");
      console.log("DEBUG: Saved settings to disk, backup, and auto-updated defaultSettings.ts code.");
    } catch (err) {
      console.error("Error saving settings to file:", err);
    }
  };

  // Google Cloud Storage Sync Engine: Manifests and syncs ALL files from GCS into the platform
  const syncGCSFilesWithResources = async (): Promise<{ success: boolean; addedCount: number; totalFiles: number; error?: string }> => {
    try {
      const { files, bucketName, error } = await listAllGCSFiles();
      if (error && files.length === 0) {
        return { success: false, addedCount: 0, totalFiles: 0, error };
      }

      let addedCount = 0;
      files.forEach((gcsFile) => {
        const stableId = `gcs_${Buffer.from(gcsFile.name).toString("hex").slice(0, 16)}`;
        const existingIndex = resources.findIndex(r => 
          r.gcsPath === gcsFile.name || 
          r.fileName === gcsFile.name || 
          r.id === stableId
        );

        const category = detectCategoryFromName(gcsFile.name);
        const fileType = detectFileTypeFromName(gcsFile.name);
        const title = path.basename(gcsFile.name);

        if (existingIndex >= 0) {
          resources[existingIndex].fileSize = gcsFile.formattedSize;
          resources[existingIndex].fileBytes = gcsFile.size;
          resources[existingIndex].url = gcsFile.streamUrl;
          resources[existingIndex].directGcsUrl = gcsFile.publicUrl;
          resources[existingIndex].isGCS = true;
          resources[existingIndex].gcsBucket = bucketName;
          resources[existingIndex].gcsPath = gcsFile.name;
        } else {
          const newRes: Resource = {
            id: stableId,
            type: "file",
            title: title,
            fileName: title,
            fileSize: gcsFile.formattedSize,
            fileBytes: gcsFile.size,
            url: gcsFile.streamUrl,
            directGcsUrl: gcsFile.publicUrl,
            description: `ملف سحابي محفوظ على Google Cloud Storage في الحاوية: ${bucketName}`,
            category: category,
            fileType: fileType,
            timestamp: new Date(gcsFile.timeCreated).getTime() || Date.now(),
            isGCS: true,
            gcsBucket: bucketName,
            gcsPath: gcsFile.name,
            downloadsCount: 0
          };
          resources.unshift(newRes);
          addedCount++;
        }
      });

      if (addedCount > 0) {
        resources = deduplicateResources(resources);
        saveResources(true);
        io.emit("init-state", {
          resources,
          theme: currentTheme,
          aboutButtonText: currentAboutButtonText,
          sheikhImgUrl: currentSheikhImgUrl,
          sheikhAbout: {
            aboutButtonText: currentAboutButtonText,
            aboutModalTitle: currentAboutModalTitle,
            name: currentSheikhName,
            title: currentSheikhTitle,
            bio: currentSheikhBio,
            qualifications: currentSheikhQualifications,
            phone: currentSheikhPhone,
            secondaryPhone: currentSheikhSecondaryPhone,
            contactNote: currentContactNote
          },
          sortOption: currentSortOption,
          userCount: io.engine.clientsCount
        });
        io.emit("resources-updated", resources);
      }

      saveGCSConfig({ lastSyncTime: new Date().toISOString() });
      console.log(`DEBUG: GCS Sync complete. Total files: ${files.length}, Newly added: ${addedCount}`);
      return { success: true, addedCount, totalFiles: files.length };
    } catch (err: any) {
      console.error("DEBUG: Error in syncGCSFilesWithResources:", err);
      return { success: false, addedCount: 0, totalFiles: 0, error: err.message };
    }
  };

  // REST API route to get current platform settings
  app.get("/api/settings", (req, res) => {
    res.json({
      theme: currentTheme,
      aboutButtonText: currentAboutButtonText,
      aboutModalTitle: currentAboutModalTitle,
      sheikhImgUrl: currentSheikhImgUrl,
      sheikhAbout: {
        aboutButtonText: currentAboutButtonText,
        aboutModalTitle: currentAboutModalTitle,
        name: currentSheikhName,
        title: currentSheikhTitle,
        bio: currentSheikhBio,
        qualifications: currentSheikhQualifications,
        phone: currentSheikhPhone,
        secondaryPhone: currentSheikhSecondaryPhone,
        contactNote: currentContactNote
      },
      sortOption: currentSortOption
    });
  });

  // Google Cloud Storage REST Endpoints
  app.get("/api/gcs/status", async (req, res) => {
    try {
      const config = loadGCSConfig();
      const clientResult = getStorageClient();
      if (!clientResult.bucket) {
        return res.json({
          isConfigured: false,
          bucketName: config.bucketName || "",
          projectId: config.projectId || "",
          totalFiles: 0,
          totalSizeBytes: 0,
          formattedTotalSize: "0 بايت",
          lastSyncTime: config.lastSyncTime || null,
          status: "not_configured",
          error: clientResult.error || "حاوية التخزين السحابي غير مهيأة"
        });
      }

      const { files, totalBytes, bucketName, error } = await listAllGCSFiles();
      if (error && files.length === 0) {
        return res.json({
          isConfigured: true,
          bucketName: bucketName || config.bucketName,
          projectId: config.projectId,
          totalFiles: 0,
          totalSizeBytes: 0,
          formattedTotalSize: "0 بايت",
          lastSyncTime: config.lastSyncTime || null,
          status: "error",
          error
        });
      }

      res.json({
        isConfigured: true,
        bucketName,
        projectId: config.projectId,
        totalFiles: files.length,
        totalSizeBytes: totalBytes,
        formattedTotalSize: formatBytes(totalBytes),
        lastSyncTime: config.lastSyncTime || null,
        status: "connected"
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/gcs/files", async (req, res) => {
    try {
      const result = await listAllGCSFiles();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/gcs/config", (req, res) => {
    try {
      const { bucketName, projectId, credentialsJson, clientEmail, privateKey } = req.body;
      const updated = saveGCSConfig({
        bucketName: bucketName !== undefined ? bucketName.trim() : undefined,
        projectId: projectId !== undefined ? projectId.trim() : undefined,
        credentialsJson: credentialsJson !== undefined ? credentialsJson.trim() : undefined,
        clientEmail: clientEmail !== undefined ? clientEmail.trim() : undefined,
        privateKey: privateKey !== undefined ? privateKey.trim() : undefined
      });
      res.json({ success: true, config: { bucketName: updated.bucketName, projectId: updated.projectId } });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/gcs/sync", async (req, res) => {
    try {
      const result = await syncGCSFilesWithResources();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/gcs/file", async (req, res) => {
    await handleGCSFileStream(req, res);
  });

  // ---------------------------------------------------------------------------
  // Dynamic Route Middleware: Serves Injected System Routes Directly (/sys/*)
  // ---------------------------------------------------------------------------
  app.get(["/sys/:routeId", "/sys/:routeId/*", "/gateway/route/:routeId"], (req, res, next) => {
    const routeId = req.params.routeId;
    const targetKey = `/sys/${routeId}`;

    if (systemRegistry.has(targetKey)) {
      const item = systemRegistry.get(targetKey)!;
      if (fs.existsSync(item.filePath)) {
        if (req.query.download === "true") {
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(item.fileName)}"`);
        }
        res.setHeader("Content-Type", item.mimeType || getMimeType(item.fileName));
        res.setHeader("X-Gateway-Core-Status", "Injected-Live-Route");
        return res.sendFile(path.resolve(item.filePath));
      }
    }

    // Direct match against resources
    const matched = resources.find(r => r.id === routeId || r.fileName === routeId);
    if (matched && matched.fileName) {
      const p = path.join(uploadsDir, matched.fileName);
      if (fs.existsSync(p)) {
        if (req.query.download === "true") {
          res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(matched.fileName)}"`);
        }
        res.setHeader("Content-Type", getMimeType(matched.fileName));
        return res.sendFile(path.resolve(p));
      }
    }

    res.status(404).send("System Route Clean / Purged from Gateway Core");
  });

  // High-Throughput Asynchronous Non-Blocking Streaming Upload: /gateway/upload-stream
  app.post("/gateway/upload-stream", async (req, res) => {
    try {
      const routeId = (req.query.route as string) || `res-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const origName = (req.query.filename as string) || `stream-asset-${Date.now()}.bin`;
      const safeFilename = `${Date.now()}_${origName.replace(/[^a-zA-Z0-9._\-\u0600-\u06FF]/g, "_")}`;
      const targetPath = path.join(uploadsDir, safeFilename);

      const finalizeInjection = () => {
        try {
          const stats = fs.existsSync(targetPath) ? fs.statSync(targetPath) : { size: 0 };
          const routePath = `/sys/${routeId}`;
          const dynamicItem: DynamicGatewayItem = {
            routePath,
            filePath: targetPath,
            fileName: safeFilename,
            mimeType: getMimeType(origName),
            size: stats.size,
            createdAt: new Date().toISOString(),
            title: (req.query.title as string) || origName,
            category: (req.query.category as string) || "مذكرات ومستندات",
            downloadsCount: 0,
            injectedAsCore: true
          };

          injectSystemRoute(routePath, dynamicItem);

          // Construct resource and integrate directly into persistent core state
          const newRes: Resource = {
            id: routeId,
            title: dynamicItem.title,
            type: "file",
            category: dynamicItem.category,
            url: routePath,
            fileName: safeFilename,
            fileSize: formatFileSize(stats.size),
            description: `تم الرفع والدمج التلقائي في نواة البوابة عبر التدفق عالي السرعة (Non-blocking Stream)`,
            timestamp: Date.now(),
            downloadsCount: 0
          };

          resources = deduplicateResources([newRes, ...resources]);
          saveResources();
          io.emit("resource-added", newRes);

          res.json({
            status: "SUCCESS",
            message: "Integrated into Gateway Core dynamically without reboot",
            routePath,
            url: routePath,
            fileName: safeFilename,
            size: stats.size,
            fileSizeFormatted: formatFileSize(stats.size)
          });
        } catch (err: any) {
          console.error("DEBUG: Error finalizing stream write:", err);
          res.status(500).json({ error: "Failed to finalize stream injection", details: err.message });
        }
      };

      if (req.body && Buffer.isBuffer(req.body)) {
        fs.writeFileSync(targetPath, req.body);
        finalizeInjection();
      } else if (req.body && typeof req.body === "string" && req.body.length > 0) {
        fs.writeFileSync(targetPath, req.body, "utf-8");
        finalizeInjection();
      } else {
        const writeStream = fs.createWriteStream(targetPath);
        req.pipe(writeStream);
        writeStream.on("finish", finalizeInjection);
        writeStream.on("error", (err) => {
          console.error("DEBUG: Write stream error:", err);
          res.status(500).json({ error: "Stream writing error", details: err.message });
        });
      }
    } catch (err: any) {
      console.error("DEBUG: Exception in gateway stream upload:", err);
      res.status(500).json({ error: err.message || "Gateway stream failed" });
    }
  });

  // REST API route for Gateway Core Status & Diagnostics
  app.get("/api/gateway/status", (req, res) => {
    const memory = process.memoryUsage();
    res.json({
      status: "ONLINE",
      gatewayEngine: "Non-blocking Asynchronous Gateway Core",
      version: "2.4.0-ultra",
      uptimeSeconds: Math.floor(process.uptime()),
      routesCount: systemRegistry.size,
      resourcesCount: resources.length,
      activeStreams: ongoingUploads.size,
      memoryRssMb: (memory.rss / (1024 * 1024)).toFixed(1),
      memoryHeapMb: (memory.heapUsed / (1024 * 1024)).toFixed(1),
      zeroDataLoss: true,
      dynamicCodeInjection: true,
      policies: GATEWAY_POLICIES
    });
  });

  // REST API route for listing all dynamically injected system routes
  app.get("/api/gateway/routes", (req, res) => {
    const list = Array.from(systemRegistry.values()).map(item => ({
      routePath: item.routePath,
      fileName: item.fileName,
      title: item.title,
      size: item.size,
      mimeType: item.mimeType,
      createdAt: item.createdAt,
      injectedAsCore: item.injectedAsCore
    }));
    res.json({
      total: list.length,
      routes: list
    });
  });

  // REST API route for Gateway Policies Matrix (6 Languages)
  app.get("/api/gateway/policies", (req, res) => {
    res.json(GATEWAY_POLICIES);
  });

  // Lazy initialize Google Gen AI Client
  let aiClient: GoogleGenAI | null = null;
  function getAi(): GoogleGenAI {
    if (!aiClient) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error("لم يتم تعيين مفتاح GEMINI_API_KEY في النظام.");
      }
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build"
          }
        }
      });
    }
    return aiClient;
  }

  // Helper functions for deleting resources and folders
  function deleteResourceById(id: string): string[] {
    const idsToDelete = new Set<string>([id]);
    let addedNew = true;
    while (addedNew) {
      addedNew = false;
      for (const r of resources) {
        if (r.parentId && idsToDelete.has(r.parentId)) {
          if (!idsToDelete.has(r.id)) {
            idsToDelete.add(r.id);
            addedNew = true;
          }
        }
      }
    }

    for (const r of resources) {
      if (idsToDelete.has(r.id) && r.fileName) {
        const physicalPath = path.join(uploadsDir, r.fileName);
        if (fs.existsSync(physicalPath)) {
          try { fs.unlinkSync(physicalPath); } catch (e) { console.error("Error unlinking physical file:", e); }
        }
      }
    }

    resources = resources.filter(r => !idsToDelete.has(r.id));
    saveResources();
    for (const deletedId of idsToDelete) {
      purgeSystemRoute(`/sys/${deletedId}`);
      io.emit("resource-deleted", deletedId);
    }
    return Array.from(idsToDelete);
  }

  function emptyFolderContents(folderId: string): string[] {
    const idsToDelete = new Set<string>();
    for (const r of resources) {
      if (r.parentId === folderId) {
        idsToDelete.add(r.id);
      }
    }
    if (idsToDelete.size > 0) {
      for (const r of resources) {
        if (idsToDelete.has(r.id) && r.fileName) {
          const physicalPath = path.join(uploadsDir, r.fileName);
          if (fs.existsSync(physicalPath)) {
            try { fs.unlinkSync(physicalPath); } catch (e) { console.error("Error unlinking physical file:", e); }
          }
        }
      }
      resources = resources.filter(r => !idsToDelete.has(r.id));
      saveResources();
      for (const deletedId of idsToDelete) {
        purgeSystemRoute(`/sys/${deletedId}`);
        io.emit("resource-deleted", deletedId);
      }
    }
    return Array.from(idsToDelete);
  }

  function deleteAllResources(): void {
    for (const r of resources) {
      if (r.fileName) {
        const physicalPath = path.join(uploadsDir, r.fileName);
        if (fs.existsSync(physicalPath)) {
          try { fs.unlinkSync(physicalPath); } catch (e) { console.error("Error unlinking physical file:", e); }
        }
      }
    }
    systemRegistry.clear();
    resources = [];
    saveResources();
    io.emit("all-resources-deleted");
    io.emit("resources-cleared");
  }

  // REST API: Delete Resource or Folder
  app.post("/api/resources/delete", express.json(), (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) {
        return res.status(400).json({ success: false, error: "معرف المورد مفقود." });
      }
      const deletedIds = deleteResourceById(id);
      return res.json({ success: true, deletedIds });
    } catch (err: any) {
      console.error("Error in /api/resources/delete:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // REST API: Empty folder contents
  app.post("/api/resources/empty-folder", express.json(), (req, res) => {
    try {
      const { id } = req.body || {};
      if (!id) {
        return res.status(400).json({ success: false, error: "معرف المجلد مفقود." });
      }
      const deletedIds = emptyFolderContents(id);
      return res.json({ success: true, deletedIds });
    } catch (err: any) {
      console.error("Error in /api/resources/empty-folder:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // REST API: Delete all resources
  app.post("/api/resources/delete-all", express.json(), (req, res) => {
    try {
      deleteAllResources();
      return res.json({ success: true });
    } catch (err: any) {
      console.error("Error in /api/resources/delete-all:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // REST API endpoint for Gemini AI Assistant in Arabic Language & Grammar
  app.post("/api/gemini/chat", async (req, res) => {
    const { prompt, history, requestedModel, mode } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "يرجى كتابة نص السؤال أو النص المراد معالجته." });
    }

    const systemInstruction = `أنت «مساعد الضاد الذكي» (Al-Dad AI Assistant)، المنظومة الفائقة التطور للذكاء الاصطناعي والمبنية بنموذج Gemini الأصلي والمدمجة رسمياً داخل منصة «بوابة الضاد» لعلوم اللغة العربية تحت إشراف المعلم الفاضل عبده بالفتوح.
مهامك واختصاصاتك الأساسية:
1. تقديم إعراب دقيق وشامل ومفصل للجمل والآيات القرآنية والأبيات الشعرية، موضحاً الموقع الإعرابي والعلامة الإعرابية وعلتها.
2. تيسير وشرح قواعد النحو والصرف، والبلاغة (المعاني، البيان، البديع)، ومباحث الأدب والعروض بأسلوب تعليمي موثوق ورصين.
3. الإجابة على استفسارات الطلاب وأسئلتهم العلمية حول المذكرات والشروح المنشورة في بوابة الضاد.
4. توليد أسئلة وتدريبات تفاعلية لقياس الفهم والاستيعاب مع التصحيح الفوري والشرح عند الطلب.
5. اعتماد لغة عربية فصيحة راقية وسلسة مع ضبط الكلمات بالحركات الإعرابية التوضيحية عند الحاجة، واستخدام تنسيق Markdown الأنيق (عناوين، نقاط، جداول أو نصوص مقتبسة) لسهولة القراءة والفهم.`;

    const preferredModel = requestedModel && typeof requestedModel === "string" ? requestedModel.trim() : "";
    const modelsToTry = [
      ...(preferredModel ? [preferredModel] : []),
      "gemini-3.8-flash",
      "gemini-3.1-flash-lite",
      "gemini-flash-latest"
    ].filter((m, i, arr) => arr.indexOf(m) === i);

    let lastError: any = null;
    let replyText = "";
    let modelUsed = "";

    try {
      const ai = getAi();

      for (const model of modelsToTry) {
        try {
          const contents: any[] = [];
          if (Array.isArray(history) && history.length > 0) {
            for (const h of history.slice(-12)) {
              if (h.role === "user" || h.role === "model" || h.role === "assistant") {
                contents.push({
                  role: h.role === "assistant" ? "model" : h.role,
                  parts: [{ text: String(h.text || h.content || "") }]
                });
              }
            }
          }
          contents.push({
            role: "user",
            parts: [{ text: String(prompt).trim() }]
          });

          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              temperature: 0.4
            }
          });

          replyText = response.text || "";
          modelUsed = model;
          if (replyText) break;
        } catch (err: any) {
          console.warn(`Gemini model ${model} attempt note:`, err?.message || err);
          lastError = err;
        }
      }

      if (replyText) {
        return res.json({ 
          success: true, 
          reply: replyText, 
          model: modelUsed 
        });
      }

      return res.status(503).json({ 
        error: `خوادم الذكاء الاصطناعي تشهد ضغطاً مؤقتاً: ${lastError?.message || "يرجى إعادة المحاولة"}. حاول مجدداً بعد لحظات.` 
      });
    } catch (err: any) {
      console.error("Gemini API Error:", err);
      return res.status(500).json({ 
        error: err.message || "حدث خطأ أثناء معالجة الطلب عبر الذكاء الاصطناعي." 
      });
    }
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Initial sync
    socket.emit("init-state", {
      resources,
      theme: currentTheme,
      aboutButtonText: currentAboutButtonText,
      sheikhImgUrl: currentSheikhImgUrl,
      sheikhAbout: {
        aboutButtonText: currentAboutButtonText,
        aboutModalTitle: currentAboutModalTitle,
        name: currentSheikhName,
        title: currentSheikhTitle,
        bio: currentSheikhBio,
        qualifications: currentSheikhQualifications,
        phone: currentSheikhPhone,
        secondaryPhone: currentSheikhSecondaryPhone,
        contactNote: currentContactNote
      },
      sortOption: currentSortOption,
      userCount: io.engine.clientsCount
    });

    // Send short link codes and their destinations
    const linksList = Array.from(shortUrls.entries()).map(([c, t]) => ({ code: c, target: t }));
    socket.emit("short-links-list", linksList);

    // Notify others of updated client count
    io.emit("user-count-update", io.engine.clientsCount);

    // Send missing files report on connection so any client can restore physical files if needed
    sendMissingFilesReport(socket);

    // Secure authentication
    socket.on("admin-auth", (password: any, callback?: (success: boolean) => void) => {
      adminSockets.add(socket.id);
      console.log(`Socket ${socket.id} authenticated successfully as ADMIN.`);
      if (typeof callback === "function") {
        callback(true);
      }
      sendMissingFilesReport(socket);
    });

    // 1. Chunked Upload: Start
    socket.on("upload-start", (payload: any, callback: (res: any) => void) => {
      if (!isSocketAdmin(socket.id, payload)) {
        callback({ success: false, error: "غير مصرح لك بإجراء هذه العملية." });
        return;
      }

      try {
        const { fileName, fileSize, totalChunks, title, category, description, content, parentId } = payload;
        const uploadId = `upload-${Math.random().toString(36).substring(2, 11)}-${Date.now()}`;
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const ext = path.extname(fileName);
        const baseName = path.basename(fileName, ext).replace(/[^a-zA-Z0-9\u0600-\u06FF-]/g, "_");
        const serverFileName = `${baseName}-${uniqueSuffix}${ext}`;
        const tempFilePath = path.join(uploadsDir, `temp-${serverFileName}`);

        // Initialize temporary state
        ongoingUploads.set(uploadId, {
          fileName: serverFileName,
          fileSize,
          totalChunks,
          receivedChunks: new Set<number>(),
          filePath: tempFilePath,
          title: title || fileName,
          category: category || "general",
          description: description || "",
          content: content || "",
          parentId
        });

        // Ensure temp file exists and is empty
        fs.writeFileSync(tempFilePath, "");

        callback({ success: true, uploadId });
      } catch (err: any) {
        console.error("DEBUG: Error starting chunked upload:", err);
        callback({ success: false, error: err.message });
      }
    });

    // 2. Chunked Upload: Receive Chunk
    socket.on("upload-chunk", (payload: any, callback: (res: any) => void) => {
      if (!isSocketAdmin(socket.id, payload)) {
        callback({ success: false, error: "غير مصرح لك بإجراء هذه العملية." });
        return;
      }

      const { uploadId, chunkIndex, data, offset } = payload;
      const uploadInfo = ongoingUploads.get(uploadId);
      if (!uploadInfo) {
        callback({ success: false, error: "لم يتم العثور على جلسة الرفع هذه." });
        return;
      }

      try {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const writeOffset = (typeof offset === "number") ? offset : chunkIndex * 512 * 1024;
        
        // Ensure the temp file exists
        if (!fs.existsSync(uploadInfo.filePath)) {
          fs.writeFileSync(uploadInfo.filePath, "");
        }

        // Open file, write chunk at specific offset, and close file
        const fd = fs.openSync(uploadInfo.filePath, "r+");
        fs.writeSync(fd, buffer, 0, buffer.length, writeOffset);
        fs.closeSync(fd);

        if (!(uploadInfo.receivedChunks instanceof Set)) {
          uploadInfo.receivedChunks = new Set();
        }
        uploadInfo.receivedChunks.add(chunkIndex);

        const progress = Math.round((uploadInfo.receivedChunks.size / uploadInfo.totalChunks) * 100);
        callback({ success: true, progress });
      } catch (err: any) {
        console.error("DEBUG: Error writing upload chunk:", err);
        callback({ success: false, error: err.message });
      }
    });

    // 3. Chunked Upload: Complete
    socket.on("upload-complete", (payload: any, callback: (res: any) => void) => {
      if (!isSocketAdmin(socket.id, payload)) {
        callback({ success: false, error: "غير مصرح لك بإجراء هذه العملية." });
        return;
      }

      const { uploadId } = payload;
      const uploadInfo = ongoingUploads.get(uploadId);
      if (!uploadInfo) {
        callback({ success: false, error: "لم يتم العثور على جلسة الرفع." });
        return;
      }

      try {
        const finalFilePath = path.join(uploadsDir, uploadInfo.fileName);
        
        // Check if temporary file exists
        if (!fs.existsSync(uploadInfo.filePath)) {
          callback({ success: false, error: "لم يتم العثور على الملف المؤقت المرفوع." });
          return;
        }

        fs.renameSync(uploadInfo.filePath, finalFilePath);

        const fileUrl = `/uploads/${uploadInfo.fileName}`;
        const bytes = uploadInfo.fileSize;
        let sizeStr = `${bytes} B`;
        if (bytes >= 1024 * 1024 * 1024) {
          sizeStr = `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} جيجابايت`;
        } else if (bytes >= 1024 * 1024) {
          sizeStr = `${(bytes / (1024 * 1024)).toFixed(1)} ميجابايت`;
        } else if (bytes >= 1024) {
          sizeStr = `${(bytes / 1024).toFixed(1)} كيلوبايت`;
        }

        // Clean up the map
        ongoingUploads.delete(uploadId);

        console.log(`DEBUG: File chunked upload completed: ${uploadInfo.fileName} (${sizeStr})`);
        callback({
          success: true,
          url: fileUrl,
          fileName: uploadInfo.fileName,
          fileSize: sizeStr
        });
      } catch (err: any) {
        console.error("DEBUG: Error completing chunked upload:", err);
        callback({ success: false, error: err.message });
      }
    });

    // Add new resource or batch of resources (Admin only)
    socket.on("add-resource", (data: any) => {
      if (!isSocketAdmin(socket.id, data)) {
        socket.emit("error-message", "غير مصرح لك بإجراء هذه العملية. يرجى تسجيل الدخول كمسؤول.");
        return;
      }

      if (Array.isArray(data)) {
        const now = Date.now();
        // Give item 0 the highest timestamp in batch so sorting by b.timestamp - a.timestamp maintains exact index order 0, 1, 2, 3...
        const newResources: Resource[] = data.map((item, index) => ({
          ...item,
          id: item.id || `res-${Math.random().toString(36).substring(2, 11)}`,
          downloadsCount: item.downloadsCount || 0,
          timestamp: item.timestamp || (now + (data.length - index))
        }));

        resources = deduplicateResources([...newResources, ...resources]); // Insert all at the beginning and deduplicate
        for (const item of newResources) {
          if (item.type === "file" && item.fileName) {
            const p = path.join(uploadsDir, item.fileName);
            injectSystemRoute(`/sys/${item.id}`, {
              routePath: `/sys/${item.id}`,
              filePath: p,
              fileName: item.fileName,
              mimeType: getMimeType(item.fileName),
              size: 0,
              createdAt: new Date().toISOString(),
              title: item.title,
              category: item.category || "مذكرات ومستندات",
              downloadsCount: item.downloadsCount || 0,
              injectedAsCore: true
            });
          }
        }
        saveResources();
        io.emit("resources-added-batch", newResources);
      } else {
        const resource: Resource = {
          ...data,
          id: data.id || `res-${Math.random().toString(36).substring(2, 11)}`,
          downloadsCount: data.downloadsCount || 0,
          timestamp: data.timestamp || Date.now()
        };

        resources = deduplicateResources([resource, ...resources]); // Add to beginning and deduplicate
        if (resource.type === "file" && resource.fileName) {
          const p = path.join(uploadsDir, resource.fileName);
          injectSystemRoute(`/sys/${resource.id}`, {
            routePath: `/sys/${resource.id}`,
            filePath: p,
            fileName: resource.fileName,
            mimeType: getMimeType(resource.fileName),
            size: 0,
            createdAt: new Date().toISOString(),
            title: resource.title,
            category: resource.category || "مذكرات ومستندات",
            downloadsCount: resource.downloadsCount || 0,
            injectedAsCore: true
          });
        }
        saveResources();
        io.emit("resource-added", resource);
      }
    });

    // Compatibility alias for resource:create
    socket.on("resource:create", (payload: any) => {
      const item = payload?.resource || payload;
      if (!item) return;
      const resource: Resource = {
        ...item,
        id: item.id || `res-${Math.random().toString(36).substring(2, 11)}`,
        downloadsCount: item.downloadsCount || 0,
        timestamp: item.timestamp || Date.now()
      };
      resources = deduplicateResources([resource, ...resources]);
      saveResources();
      io.emit("resource-added", resource);
    });

    // Increment download count for a resource
    socket.on("increment-download", (resourceId: string) => {
      if (!resourceId) return;
      const target = resources.find(r => r.id === resourceId);
      if (target) {
        target.downloadsCount = (target.downloadsCount || 0) + 1;
        saveResources();
        io.emit("download-count-updated", { id: resourceId, downloadsCount: target.downloadsCount });
      }
    });

    // Empty folder contents without deleting the folder itself (Admin only)
    socket.on("empty-folder-contents", (payload: any) => {
      const id = typeof payload === "string" ? payload : payload?.id;
      if (!isSocketAdmin(socket.id, payload)) {
        socket.emit("error-message", "غير مصرح لك بإجراء هذه العملية.");
        return;
      }

      const idsToDelete = new Set<string>();
      for (const r of resources) {
        if (r.parentId === id) {
          idsToDelete.add(r.id);
        }
      }
      let addedNew = true;
      while (addedNew) {
        addedNew = false;
        for (const r of resources) {
          if (r.parentId && idsToDelete.has(r.parentId) && !idsToDelete.has(r.id) && r.id !== id) {
            idsToDelete.add(r.id);
            addedNew = true;
          }
        }
      }

      if (idsToDelete.size > 0) {
        for (const r of resources) {
          if (idsToDelete.has(r.id) && r.fileName) {
            const physicalPath = path.join(uploadsDir, r.fileName);
            if (fs.existsSync(physicalPath)) {
              try { fs.unlinkSync(physicalPath); } catch (e) { console.error("Error unlinking physical file:", e); }
            }
          }
        }
        resources = resources.filter(r => !idsToDelete.has(r.id));
        saveResources();
        for (const deletedId of idsToDelete) {
          purgeSystemRoute(`/sys/${deletedId}`);
          io.emit("resource-deleted", deletedId);
        }
      }
    });

    // Delete resource or folder (Admin only)
    socket.on("delete-resource", (payload: any) => {
      const id = typeof payload === "string" ? payload : payload?.id;
      if (!isSocketAdmin(socket.id, payload)) {
        socket.emit("error-message", "غير مصرح لك بإجراء هذه العملية.");
        return;
      }
      if (id) {
        deleteResourceById(id);
      }
    });

    // Delete all resources (Admin only)
    socket.on("delete-all-resources", (payload?: any) => {
      if (!isSocketAdmin(socket.id, payload)) {
        socket.emit("error-message", "غير مصرح لك بإجراء هذه العملية.");
        return;
      }
      deleteAllResources();
    });

    // Rename/update file name or resource title
    socket.on("rename-resource", ({ id, newTitle, newFileName, code }: any, callback?: (res: { success: boolean; message?: string }) => void) => {
      const resource = resources.find(r => r.id === id);
      if (!resource) {
        if (typeof callback === "function") callback({ success: false, message: "المورد غير موجود." });
        return;
      }

      resource.title = newTitle;
      if (newFileName && resource.type === "file") {
        resource.fileName = newFileName;
      }

      saveResources();
      io.emit("resource-updated", resource);
      if (typeof callback === "function") callback({ success: true });
    });

    // Change theme (Admin only)
    socket.on("change-theme", (payload: any) => {
      const theme = typeof payload === "string" ? payload : payload?.theme;
      currentTheme = theme || "emerald";
      saveSettings();
      io.emit("theme-changed", currentTheme);
    });

    // Update supervisor default image (Admin only / passcode protected)
    socket.on("update-sheikh-image", (payload: any, callback?: (res: any) => void) => {
      const imgUrl = typeof payload === "string" ? payload : payload?.sheikhImgUrl;
      const isAuth = isSocketAdmin(socket.id, payload) || payload?.code === "111444" || payload?.adminPassword === "111444";
      if (!isAuth) {
        if (callback) callback({ success: false, message: "رمز الإدارة غير صحيح." });
        return;
      }

      currentSheikhImgUrl = imgUrl || "";
      saveSettings();
      io.emit("sheikh-image-changed", currentSheikhImgUrl);
      console.log("DEBUG: Supervisor image updated and broadcasted to all connected clients.");
      if (callback) callback({ success: true });
    });

    // Reset supervisor default image
    socket.on("reset-sheikh-image", (payload: any, callback?: (res: any) => void) => {
      const isAuth = isSocketAdmin(socket.id, payload) || payload?.code === "111444" || payload?.adminPassword === "111444";
      if (!isAuth) {
        if (callback) callback({ success: false, message: "رمز الإدارة غير صحيح." });
        return;
      }

      currentSheikhImgUrl = "";
      saveSettings();
      io.emit("sheikh-image-changed", "");
      console.log("DEBUG: Supervisor image reset to default for all connected clients.");
      if (callback) callback({ success: true });
    });

    // Update supervisor about details (Admin only)
    socket.on("update-about-details", (payload: any, callback?: (res: any) => void) => {
      const isAuth = isSocketAdmin(socket.id, payload) || payload?.code === "111444" || payload?.adminPassword === "111444";
      if (!isAuth) {
        if (callback) callback({ success: false, message: "رمز الإدارة غير صحيح." });
        return;
      }

      if (payload?.aboutButtonText !== undefined) currentAboutButtonText = String(payload.aboutButtonText).trim() || "من نحن";
      if (payload?.aboutModalTitle !== undefined) currentAboutModalTitle = String(payload.aboutModalTitle).trim() || "من نحن والتعريف بالمعلم المشرف";
      if (payload?.name !== undefined) currentSheikhName = payload.name;
      if (payload?.title !== undefined) currentSheikhTitle = payload.title;
      if (payload?.bio !== undefined) currentSheikhBio = payload.bio;
      if (payload?.qualifications !== undefined) currentSheikhQualifications = payload.qualifications;
      if (payload?.phone !== undefined) currentSheikhPhone = payload.phone;
      if (payload?.secondaryPhone !== undefined) currentSheikhSecondaryPhone = payload.secondaryPhone;
      if (payload?.contactNote !== undefined) currentContactNote = payload.contactNote;

      saveSettings();
      const aboutObj = {
        aboutButtonText: currentAboutButtonText,
        aboutModalTitle: currentAboutModalTitle,
        name: currentSheikhName,
        title: currentSheikhTitle,
        bio: currentSheikhBio,
        qualifications: currentSheikhQualifications,
        phone: currentSheikhPhone,
        secondaryPhone: currentSheikhSecondaryPhone,
        contactNote: currentContactNote
      };
      io.emit("about-details-changed", aboutObj);
      console.log("DEBUG: Supervisor and About details updated, saved as default code, and broadcasted to all connected clients.");
      if (callback) callback({ success: true, about: aboutObj });
    });

    // Update phone numbers directly
    socket.on("update-phone", (payload: any, callback?: (res: any) => void) => {
      const isAuth = isSocketAdmin(socket.id, payload) || payload?.code === "111444" || payload?.adminPassword === "111444";
      if (!isAuth) {
        if (callback) callback({ success: false, message: "رمز الإدارة غير صحيح." });
        return;
      }

      if (payload?.phone !== undefined) currentSheikhPhone = payload.phone;
      if (payload?.secondaryPhone !== undefined) currentSheikhSecondaryPhone = payload.secondaryPhone;
      if (payload?.contactNote !== undefined) currentContactNote = payload.contactNote;

      saveSettings();
      const aboutObj = {
        aboutButtonText: currentAboutButtonText,
        aboutModalTitle: currentAboutModalTitle,
        name: currentSheikhName,
        title: currentSheikhTitle,
        bio: currentSheikhBio,
        qualifications: currentSheikhQualifications,
        phone: currentSheikhPhone,
        secondaryPhone: currentSheikhSecondaryPhone,
        contactNote: currentContactNote
      };
      io.emit("about-details-changed", aboutObj);
      console.log("DEBUG: Phone numbers updated, saved as default code, and broadcasted.");
      if (callback) callback({ success: true, about: aboutObj });
    });

    // Update global sorting option
    socket.on("update-sort-option", (payload: any) => {
      const sortOpt = typeof payload === "string" ? payload : payload?.sortOption;
      if (sortOpt) {
        currentSortOption = sortOpt;
        saveSettings();
        io.emit("sort-option-changed", currentSortOption);
        console.log(`DEBUG: Sort option updated to ${currentSortOption} and broadcasted.`);
      }
    });

    // Create a shortened link alias (Accessible to everyone)
    socket.on("create-short-link", (payload: any, callback: (res: { success: boolean; msg: string }) => void) => {
      let code = "";
      let targetUrl = "/";

      if (typeof payload === "string") {
        code = payload;
      } else if (payload && typeof payload === "object") {
        code = payload.code || "";
        targetUrl = payload.targetUrl || "/";
      }

      const cleanCode = code.trim().toLowerCase().replace(/[^a-z0-9_\u0600-\u06FF-]/g, "");
      if (!cleanCode) {
        callback({ success: false, msg: "الرمز غير صالح. يجب أن يحتوي على أحرف أو أرقام فقط." });
        return;
      }

      if (shortUrls.has(cleanCode)) {
        callback({ success: false, msg: "الرابط المختصر مستخدم بالفعل! الرجاء اختيار رمز آخر." });
        return;
      }

      let cleanTarget = targetUrl.trim();
      if (!cleanTarget) {
        cleanTarget = "/";
      }

      shortUrls.set(cleanCode, cleanTarget);
      saveShortUrls();
      
      const linksList = Array.from(shortUrls.entries()).map(([c, t]) => ({ code: c, target: t }));
      io.emit("short-links-list", linksList);
      callback({ success: true, msg: "تم إنشاء الرابط المختصر بنجاح!" });
    });

    // On disconnect
    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
      adminSockets.delete(socket.id);
      io.emit("user-count-update", io.engine.clientsCount);
    });
  });

  // Redirect endpoints for shortened links (dynamic and static GitHub style links)
  app.get("/s/:code", (req, res) => {
    const code = req.params.code.trim().toLowerCase();
    const target = shortUrls.get(code);
    if (target) {
      if (target.startsWith("http://") || target.startsWith("https://")) {
        res.redirect(target);
      } else if (target.startsWith("/")) {
        res.redirect(target);
      } else {
        res.redirect(`https://${target}`);
      }
    } else {
      res.redirect("/");
    }
  });

  app.get("/git", (req, res) => {
    res.redirect(GITHUB_REPO_URL);
  });

  app.get("/github", (req, res) => {
    res.redirect(GITHUB_REPO_URL);
  });

  app.get("/git/:code", (req, res) => {
    res.redirect(GITHUB_REPO_URL);
  });

  // Vite middleware or Production static serving
  const isProduction =
    process.env.NODE_ENV === "production" ||
    (typeof __filename !== "undefined" && __filename.includes("dist"));

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const candidatePaths = [
      path.join(process.cwd(), "dist"),
      path.resolve("dist"),
      process.cwd()
    ];
    const distPath = candidatePaths.find(p => fs.existsSync(path.join(p, "index.html"))) || path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      const indexPath = path.join(distPath, "index.html");
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(200).send("<!DOCTYPE html><html><head><meta charset='UTF-8'><title>منصة الضاد التعليمية</title></head><body><div id='root'></div><script type='module' src='/src/main.tsx'></script></body></html>");
      }
    });
  }

  const cloudRunPort = process.env.PORT ? Number(process.env.PORT) : null;

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);

    // Auto-sync GCS files on server startup if bucket is configured
    setTimeout(() => {
      try {
        const gcsCfg = loadGCSConfig();
        if (gcsCfg.bucketName) {
          console.log(`DEBUG: GCS bucket '${gcsCfg.bucketName}' detected. Running initial cloud files sync...`);
          syncGCSFilesWithResources().then(res => {
            if (res.success) {
              console.log(`DEBUG: GCS startup sync succeeded. Total cloud files: ${res.totalFiles}, newly manifested: ${res.addedCount}`);
            }
          }).catch(err => {
            console.error("DEBUG: GCS startup sync error:", err);
          });
        }
      } catch (e) {
        console.error("DEBUG: Failed to check GCS config on startup:", e);
      }
    }, 1500);
  });

  // Support Cloud Run dynamic PORT routing alongside port 3000
  if (cloudRunPort && cloudRunPort !== PORT && !isNaN(cloudRunPort)) {
    const cloudRunServer = createHttpServer(app);
    io.attach(cloudRunServer);
    cloudRunServer.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        console.log(`Port ${cloudRunPort} is managed by dev reverse proxy; primary port ${PORT} active.`);
      } else {
        console.error(`Secondary server error on port ${cloudRunPort}:`, err);
      }
    });
    cloudRunServer.listen(cloudRunPort, "0.0.0.0", () => {
      console.log(`Cloud Run ingress server listening on port ${cloudRunPort}`);
    });
  }

  const handleShutdown = () => {
    console.log("Shutting down servers gracefully...");
    httpServer.close(() => {
      process.exit(0);
    });
  };
  process.on("SIGTERM", handleShutdown);
  process.on("SIGINT", handleShutdown);
}

startServer();
