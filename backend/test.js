import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("Error: GEMINI_API_KEY is missing in your .env file!");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function testHello() {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash", // or any model string from your previous list
      contents: "Hello! reply with a quick confirmation.",
    });

    console.log("API Response:");
    console.log(response.text);
  } catch (error) {
    console.error("API Call Failed:", error);
  }
}

testHello();