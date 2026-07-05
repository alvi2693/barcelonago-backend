import express from "express";
import cors from "cors";
import contactRoutes from "./routes/contact";
import reservationRoutes from "./routes/reservations";
import notificationRoutes, { initNotifications, sendDailyNotifications } from "./routes/notifications";
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

initDb().then(async () => {
  await initNotifications();

  // Cron diario a las 8:00 AM (España UTC+2 = 6:00 UTC)
  function scheduleDailyAt8() {
    const now = new Date();
    const next = new Date();
    next.setUTCHours(6, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const ms = next.getTime() - now.getTime();
    setTimeout(() => {
      sendDailyNotifications();
      setInterval(sendDailyNotifications, 24 * 60 * 60 * 1000);
    }, ms);
    console.log(`⏰ Notificaciones diarias programadas`);
  }

  scheduleDailyAt8();

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});