/* 回声消除 stub：preprocess.c 链接时需要 speex_echo_get_residual 符号，
 * 我们不做回声消除（echo_state 始终为 NULL，不会真调用），给个空实现满足链接。 */
#include "config.h"               // 先定义 FLOATING_POINT（arch.h 依赖）
#include "arch.h"                 // spx_word32_t 在此定义（FLOATING_POINT 下 = float）
#include "speex/speex_echo.h"

void speex_echo_get_residual(SpeexEchoState *st, spx_word32_t *Yout, int len) {
  (void)st; (void)Yout; (void)len;
}
