import { useEffect, useRef, useState, useCallback } from 'react';
import { Modality } from '@google/genai';
import BasicFace from '../basic-face/BasicFace';
import { useLiveAPIContext } from '../../../contexts/LiveAPIContext';
import { createSystemInstructions } from '@/lib/prompts';
import { useAgent, useUser } from '@/lib/state';

const IMAGE_TRIGGERS: { keyword: string; url: string }[] = [
  {
    keyword: 'ліквідні земельні ділянки та будівлі',
    url: 'https://res.cloudinary.com/dfasvauom/image/upload/v1773421817/bot1NP_bgbncz.jpg',
  },
  {
    keyword: 'дбають про своє майбутнє',
    url: 'https://res.cloudinary.com/dfasvauom/image/upload/v1773422142/bot2NP_lwetga.jpg',
  },
];

const AUTO_CLOSE_MS = 7000; // автозакрытие через 7 секунд

export default function KeynoteCompanion() {
  const { client, connected, setConfig } = useLiveAPIContext();
  const faceCanvasRef = useRef<HTMLCanvasElement>(null);
  const user = useUser();
  const { current } = useAgent();
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  const [canvasReady, setCanvasReady] = useState(false);

  // ─── Черга зображень ──────────────────────────────────────────────────────
  const imageQueueRef = useRef<string[]>([]);
  const isShowingRef = useRef(false);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Колбек для розблокування моделі після закриття картинки
  const onImageClosedRef = useRef<(() => void) | null>(null);

  const clearAutoCloseTimer = () => {
    if (autoCloseTimerRef.current) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
  };

  const showImage = useCallback((url: string) => {
    isShowingRef.current = true;
    setCurrentImage(url);
    console.log('🖼️ Showing image:', url);

    // Автозакрытие через 7 секунд
    clearAutoCloseTimer();
    autoCloseTimerRef.current = setTimeout(() => {
      console.log('⏱️ Auto-closing image after 7s');
      closeImage();
    }, AUTO_CLOSE_MS);
  }, []);

  const closeImage = useCallback(() => {
    clearAutoCloseTimer();

    const next = imageQueueRef.current.shift() ?? null;

    // Разблокируем модель — она может продолжать говорить
    if (onImageClosedRef.current) {
      onImageClosedRef.current();
      onImageClosedRef.current = null;
    }

    if (next) {
      setCurrentImage(null);
      setTimeout(() => showImage(next), 1000); // 1 сек пауза между картинками
    } else {
      isShowingRef.current = false;
      setCurrentImage(null);
    }
  }, [showImage]);

  const enqueueImage = useCallback((url: string) => {
    if (!isShowingRef.current) {
      showImage(url);
    } else {
      imageQueueRef.current.push(url);
      console.log('📋 Image queued:', url, '| Queue length:', imageQueueRef.current.length);
    }
  }, [showImage]);

  // ─── Refs для fallback ────────────────────────────────────────────────────
  const shownRef = useRef(new Set<string>());
  const pendingCheckRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Инициализация Canvas
  useEffect(() => {
    if (faceCanvasRef.current) {
      console.log('🟢 Canvas инициализирован:', faceCanvasRef.current);
      setCanvasReady(true);
    }
  }, [faceCanvasRef.current]);

  // Настройка конфига для Live API
  useEffect(() => {
    async function setupConfig() {
      console.log('🚀 INITIALIZATION: Setting up config...');
      const systemInstruction = createSystemInstructions(current, user);
      setConfig({
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: current.voice } },
        },
        systemInstruction: { parts: [{ text: systemInstruction }] },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'show_image',
                description: 'Display image on screen (modal overlay). Wait for the tool response before continuing speech — the response confirms the user has seen the image.',
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    imageUrl: { type: 'STRING' },
                  },
                  required: ['imageUrl'],
                },
              },
            ],
          },
        ],
      });
    }
    setupConfig();
  }, [setConfig, user, current]);

  // ─── Обработка toolcall + молчание бота ───────────────────────────────────
  useEffect(() => {
    if (!client || !connected) {
      console.log('⚠️ Client or connection not ready:', { client: !!client, connected });
      return;
    }

    console.log('✅ Tool call handler registered');

    const handleToolCall = async (toolCall: any) => {
      if (!toolCall.functionCalls?.length) return;

      const responses = await Promise.all(
        toolCall.functionCalls.map(async (fc: any, index: number) => {
          console.log(`🧩 Function Call #${index + 1}: ${fc.name}`);

          if (fc.name === 'show_image') {
            const imageUrl = fc.args?.imageUrl || fc.args?.url;
            console.log('🖼️ show_image called with URL:', imageUrl);

            if (!imageUrl || !imageUrl.startsWith('http')) {
              return {
                name: fc.name,
                id: fc.id,
                response: { result: { success: false, error: 'Invalid image URL' } },
              };
            }

            shownRef.current.add(imageUrl);
            if (pendingCheckRef.current) {
              clearTimeout(pendingCheckRef.current);
              pendingCheckRef.current = null;
            }

            enqueueImage(imageUrl);
            console.log('✅ Image enqueued');

            // ─── Блокируем модель до закрытия картинки ────────────────────
            // Модель молчит пока пользователь не закроет (или 7 сек)
            return new Promise<any>((resolve) => {
              onImageClosedRef.current = () => {
                console.log('🔓 Image closed — unblocking model');
                resolve({
                  name: fc.name,
                  id: fc.id,
                  response: {
                    result: { success: true, message: 'Image was shown and closed by user.' },
                  },
                });
              };
            });
          }

          return null;
        })
      );

      const validResponses = responses.filter(Boolean);
      client.sendToolResponse({ functionResponses: validResponses });
    };

    const handleTurnEnd = () => {
      // textBuffer не используется (AUDIO mode), оставляем для совместимости
    };

    client.on('toolcall', handleToolCall);
    client.on('turncomplete', handleTurnEnd);
    return () => {
      client.off('toolcall', handleToolCall);
      client.off('turncomplete', handleTurnEnd);
      if (pendingCheckRef.current) clearTimeout(pendingCheckRef.current);
      clearAutoCloseTimer();
    };
  }, [client, connected, enqueueImage]);

  // Лог смены изображения
  useEffect(() => {
    console.log('🖼️ IMAGE STATE CHANGED:', currentImage);
  }, [currentImage]);

  return (
    <>
      {currentImage && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} />

          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              maxWidth: '95vw',
              maxHeight: '95vh',
              zIndex: 9999,
            }}
          >
            <img
              src={currentImage}
              alt="full"
              onClick={(e) => e.stopPropagation()}
              style={{
                maxWidth: '95vw',
                maxHeight: '95vh',
                width: 'auto',
                height: 'auto',
                objectFit: 'contain',
                borderRadius: '16px',
                boxShadow: '0 0 60px rgba(0,0,0,0.8)',
              }}
            />
            <button
              onClick={closeImage}
              style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                background: 'rgba(0,0,0,0.75)',
                color: 'white',
                border: 'none',
                borderRadius: '50%',
                width: '44px',
                height: '44px',
                fontSize: '28px',
                fontWeight: 'bold',
                cursor: 'pointer',
                zIndex: 10001,
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backdropFilter: 'blur(10px)',
              }}
            >
              ×
            </button>
          </div>
        </>
      )}

      <div
        className="keynote-companion"
        style={{ position: 'relative', width: '100%', height: '100%', zIndex: 1 }}
      >
        <BasicFace canvasRef={faceCanvasRef!} color={current.bodyColor} />
      </div>

      <details className="info-overlay">
        <summary className="info-button">
          <span className="icon">info</span>
        </summary>
        <div className="info-text">
          <p>
            Experimental model from Google DeepMind. Adapted for the service.
            Speaks many languages. On iOS, disable AVR.
          </p>
        </div>
      </details>
    </>
  );
}
