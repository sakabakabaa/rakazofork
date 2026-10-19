ALTER TABLE "space_model_preferences"
ADD COLUMN "imageGenerationModelId" TEXT;

CREATE UNIQUE INDEX "space_model_preferences_image_generation_key"
ON "space_model_preferences" ("spaceId", "userId")
WHERE "imageGenerationModelId" IS NOT NULL;
