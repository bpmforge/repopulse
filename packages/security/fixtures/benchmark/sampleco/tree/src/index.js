const express = require("express");
const config = require("./config");
const invoiceRoutes = require("./routes/invoiceRoutes");
const authRoutes = require("./routes/authRoutes");
const adminRoutes = require("./routes/adminRoutes");

const app = express();
app.use(express.json());
app.use("/invoices", invoiceRoutes);
app.use("/auth", authRoutes);
app.use("/admin", adminRoutes);
app.listen(config.port, () => console.log("SampleCo on " + config.port));
