import express from "express";
import cors from "cors";
import contactRoutes from "./routes/contact";
import reservationRoutes from "./routes/reservations";
import notificationRoutes, { initNotifications } from "./routes/notifications";
import expenseRoutes from "./routes/expenses";
import { initDb } from "./db";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.send("🚀 BCN Rooms Backend is running");
});

app.use(contactRoutes);
app.use(reservationRoutes);
app.use(notificationRoutes);
app.use(expenseRoutes);

const PORT = process.env.PORT || 3001;

// NOTA: en el plan gratuito de Render el servicio se duerme, por lo que
// un cron interno no dispara. Los recordatorios los lanza cron-job.org
// llamando cada hora a GET /push/cron?key=CRON_KEY, que decide qué avisos
// tocan según la hora de Madrid.

initDb().then(async () => {
  await initNotifications();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});