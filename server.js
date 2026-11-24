const express = require("express");
const path = require("path");
const crypto = require("crypto");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 3000;
const CLAVE_ADMIN = "iglesia2026";
const MAX_CUPOS = 250;
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbz-8KX14Ti3zxNeFRkFwakP9wWPwJDi_3tBM9X2ACiarneeJCqo3VBl1RRGOEGQxSM/exec";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

async function leerDB() {
  const res = await fetch(SHEETS_URL, { redirect: "follow" });
  if (!res.ok) {
    throw new Error("No se pudo conectar con Google Sheets");
  }
  const data = await res.json();
  return {
    usuarios: Array.isArray(data.usuarios) ? data.usuarios : [],
    registros: Array.isArray(data.registros) ? data.registros : []
  };
}

async function guardarEnSheets(tipo, datos) {
  const res = await fetch(SHEETS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tipo, datos }),
    redirect: "follow"
  });
  if (!res.ok) {
    throw new Error("No se pudo guardar en Google Sheets");
  }
}

function encriptarClave(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

// 0. Consultar cupos disponibles
app.get("/api/cupos", async (req, res) => {
  try {
    const db = await leerDB();
    const ocupados = db.registros.length;
    const disponibles = Math.max(0, MAX_CUPOS - ocupados);
    res.json({
      ok: true,
      maxCupos: MAX_CUPOS,
      ocupados,
      disponibles,
      lleno: disponibles === 0
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Error consultando cupos disponibles." });
  }
});

// 1. Crear cuenta
app.post("/api/crear-cuenta", async (req, res) => {
  try {
    const db = await leerDB();
    if (db.registros.length >= MAX_CUPOS) {
      return res.status(400).json({
        ok: false,
        error: "Las inscripciones están llenas. Para más información, contáctate al WhatsApp que está abajo."
      });
    }

    const { correo, password } = req.body;
    if (!correo || !password || password.length < 4) {
      return res.status(400).json({ ok: false, error: "Ingresa un correo válido y una contraseña de al menos 4 caracteres." });
    }

    const correoLimpio = correo.trim().toLowerCase();
    if (db.usuarios.some((u) => u.correo === correoLimpio)) {
      return res.status(400).json({ ok: false, error: "Este correo ya tiene una cuenta. Inicia sesión." });
    }

    const token = crypto.randomBytes(24).toString("hex");
    const nuevoUsuario = {
      correo: correoLimpio,
      password: encriptarClave(password),
      token
    };

    await guardarEnSheets("usuario", nuevoUsuario);

    res.json({ ok: true, token, correo: correoLimpio, yaRegistro: false });
  } catch (err) {
    res.status(500).json({ ok: false, error: "No se pudo crear la cuenta. Intenta de nuevo." });
  }
});

// 2. Iniciar sesión
app.post("/api/iniciar-sesion", async (req, res) => {
  try {
    const { correo, password } = req.body;
    const db = await leerDB();
    const correoLimpio = (correo || "").trim().toLowerCase();
    const usuario = db.usuarios.find(
      (u) => u.correo === correoLimpio && u.password === encriptarClave(password || "")
    );

    if (!usuario) {
      return res.status(401).json({ ok: false, error: "Correo o contraseña incorrectos." });
    }

    const yaRegistro = db.registros.some((r) => r.correoCuenta === correoLimpio);
    res.json({ ok: true, token: usuario.token, correo: correoLimpio, yaRegistro });
  } catch (err) {
    res.status(500).json({ ok: false, error: "Error al iniciar sesión. Intenta de nuevo." });
  }
});

// 3. Apartar cupo
app.post("/api/apartar-cupo", async (req, res) => {
  try {
    const { token, nombreApellido, telefono, cedula, dondeVive, perteneceIglesia, nombreIglesia } = req.body;
    const db = await leerDB();

    const usuario = db.usuarios.find((u) => u.token === token);
    if (!usuario) {
      return res.status(401).json({ ok: false, error: "Sesión inválida. Vuelve a iniciar sesión." });
    }

    if (db.registros.some((r) => r.correoCuenta === usuario.correo)) {
      return res.status(400).json({ ok: false, error: "Ya apartaste tu cupo con esta cuenta." });
    }

    if (db.registros.length >= MAX_CUPOS) {
      return res.status(400).json({
        ok: false,
        error: "Las inscripciones están llenas. Para más información, contáctate al WhatsApp que está abajo."
      });
    }

    const cedulaLimpia = (cedula || "").trim().toUpperCase();
    if (db.registros.some((r) => r.cedula === cedulaLimpia)) {
      return res.status(400).json({ ok: false, error: "Esta cédula ya se encuentra registrada." });
    }

    const esMiembro = perteneceIglesia === "Sí";
    if (!nombreApellido || !telefono || !cedulaLimpia || !dondeVive || (esMiembro && !nombreIglesia)) {
      return res.status(400).json({ ok: false, error: "Por favor completa todos los campos obligatorios." });
    }

    const nuevoRegistro = {
      controlInterno: db.registros.length + 1,
      fechaRegistro: new Date().toLocaleString("es-VE", { timeZone: "America/Caracas" }),
      correoCuenta: usuario.correo,
      nombreApellido: nombreApellido.trim(),
      cedula: cedulaLimpia,
      telefono: telefono.trim(),
      dondeVive: dondeVive.trim(),
      perteneceIglesia: esMiembro ? "Sí" : "No",
      nombreIglesia: esMiembro ? nombreIglesia.trim() : "No aplica"
    };

    await guardarEnSheets("registro", nuevoRegistro);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: "No se pudo guardar tu cupo. Intenta de nuevo." });
  }
});

// 4. Descargar Excel de control interno
app.get("/descargar-excel", async (req, res) => {
  if (req.query.clave !== CLAVE_ADMIN) {
    return res.status(403).send("Acceso denegado. Clave incorrecta.");
  }

  try {
    const db = await leerDB();
    const filas = db.registros.map((r) => ({
      "N° Control": r.controlInterno,
      "Fecha de Registro": r.fechaRegistro,
      "Nombre y Apellido": r.nombreApellido,
      "Cédula": r.cedula,
      "Teléfono": r.telefono,
      "Dónde Vive": r.dondeVive,
      "¿Pertenece a una Iglesia?": r.perteneceIglesia,
      "Nombre de la Iglesia": r.nombreIglesia,
      "Correo de Cuenta": r.correoCuenta
    }));

    const libro = XLSX.utils.book_new();
    const hoja = XLSX.utils.json_to_sheet(filas);
    XLSX.utils.book_append_sheet(libro, hoja, "Registros");

    const buffer = XLSX.write(libro, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Disposition", 'attachment; filename="Registro_Actividad_1_Diciembre.xlsx"');
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buffer);
  } catch (err) {
    res.status(500).send("Error generando el archivo Excel.");
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
