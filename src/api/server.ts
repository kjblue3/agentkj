import express from "express";
import { z } from "zod";
import type { InvestigationPipeline } from "../investigation/pipeline.js";
import { demoQuestions } from "../data/demoData.js";

const requestSchema = z.object({ question: z.string().trim().min(3).max(500) });

export function createApi(pipeline: InvestigationPipeline) {
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "slack-detective" });
  });

  app.get("/demo/questions", (_request, response) => {
    response.json({ questions: demoQuestions });
  });

  app.get("/evidence/:id", async (request, response) => {
    const item = await pipeline.getEvidence(request.params.id);
    if (!item) {
      response.status(404).json({ error: "Evidence not found" });
      return;
    }
    response.json(item);
  });

  app.post("/investigate", async (request, response, next) => {
    try {
      const { question } = requestSchema.parse(request.body);
      response.json(await pipeline.investigate(question));
    } catch (error) {
      if (error instanceof z.ZodError) {
        response.status(400).json({ error: "Invalid request", details: error.issues });
        return;
      }
      next(error);
    }
  });

  app.use((
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(error);
    response.status(500).json({ error: "Investigation failed" });
  });

  return app;
}
