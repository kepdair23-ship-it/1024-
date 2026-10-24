/**
 * 퀴즈 챔피언 (Quiz Champion) - 진행 상태 관리, 점수/콤보/레벨 채점 및 선택적 제출 모듈
 *
 * [선생님을 위한 안내]
 * 1. 학생들의 퀴즈 결과를 Google 스프레드시트 등으로 취합하려면 아래 SUBMISSION_ENDPOINT 변수에
 *    배포한 Google Apps Script 웹 앱 URL(예: 'https://script.google.com/macros/s/.../exec')을 입력하세요.
 * 2. URL이 비어 있는 기본 상태에서는 어떠한 네트워크 전송도 일어나지 않으며, 모든 게임은 기기 내에서만 안전하게 동작합니다.
 * 3. [개인정보 처리 주의사항]: 실제 학교 수업에서 학생들의 결과를 외부로 전송·보관하고자 할 때는,
 *    반·번호 또한 식별 정보에 해당하므로 학교의 개인정보 처리 지침(수집 목적, 적법 근거, 열람 권한, 보유 기간 및 파기 절차)을
 *    반드시 확인하고 적합하게 운영해 주시기 바랍니다. 이름(성명·닉네임)은 본 프로그램에서 절대 수집하지 않습니다.
 */

const SUBMISSION_ENDPOINT = 'https://script.google.com/macros/s/AKfycbw2lBMrdv476bODoJIzqvcLVDWzoFQ_0Wb6XKl54hxX5-UTqUnVFuPPUAvl2EUN-TmsAw/exec';

(function () {
  'use strict';

  // 세션 메모리 상태 (localStorage/쿠키 영구 보관 금지)
  const state = {
    classNumber: null,
    studentNumber: null,
    currentQuestionIndex: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    correctCount: 0,
    answers: [], // { questionId, selectedIndex, isCorrect }
    hasSubmitted: false,
    submissionStatus: 'idle' // 'idle' | 'sending' | 'success' | 'error'
  };

  /**
   * 반 및 번호 유효성 검사 (1~99 정수)
   * @param {string|number} rawClass
   * @param {string|number} rawStudent
   * @returns {{ isValid: boolean, classError: string, studentError: string, classNum: number|null, studentNum: number|null }}
   */
  function validateStudentInfo(rawClass, rawStudent) {
    const res = {
      isValid: true,
      classError: '',
      studentError: '',
      classNum: null,
      studentNum: null
    };

    const trimClass = String(rawClass === null || rawClass === undefined ? '' : rawClass).trim();
    const trimStudent = String(rawStudent === null || rawStudent === undefined ? '' : rawStudent).trim();

    // 반 검증
    if (!trimClass) {
      res.isValid = false;
      res.classError = '반을 입력해 주세요 (1~99)';
    } else if (!/^\d+$/.test(trimClass)) {
      res.isValid = false;
      res.classError = '반은 1~99 사이의 정수만 입력할 수 있어요';
    } else {
      const num = parseInt(trimClass, 10);
      if (num < 1 || num > 99) {
        res.isValid = false;
        res.classError = '반은 1부터 99까지만 가능해요';
      } else {
        res.classNum = num;
      }
    }

    // 번호 검증
    if (!trimStudent) {
      res.isValid = false;
      res.studentError = '번호를 입력해 주세요 (1~99)';
    } else if (!/^\d+$/.test(trimStudent)) {
      res.isValid = false;
      res.studentError = '번호는 1~99 사이의 정수만 입력할 수 있어요';
    } else {
      const num = parseInt(trimStudent, 10);
      if (num < 1 || num > 99) {
        res.isValid = false;
        res.studentError = '번호는 1부터 99까지만 가능해요';
      } else {
        res.studentNum = num;
      }
    }

    return res;
  }

  /**
   * 학생 정보 등록 및 게임 세션 시작
   */
  function startSession(rawClass, rawStudent) {
    const val = validateStudentInfo(rawClass, rawStudent);
    if (!val.isValid) {
      return { success: false, ...val };
    }

    state.classNumber = val.classNum;
    state.studentNumber = val.studentNum;
    state.currentQuestionIndex = 0;
    state.score = 0;
    state.combo = 0;
    state.maxCombo = 0;
    state.correctCount = 0;
    state.answers = [];
    state.hasSubmitted = false;
    state.submissionStatus = 'idle';

    return {
      success: true,
      classNumber: state.classNumber,
      studentNumber: state.studentNumber
    };
  }

  /**
   * 누적 정답 수에 따른 레벨 계산
   * 0~2개: Lv.1, 3~5개: Lv.2, 6~8개: Lv.3, 9개 이상: Lv.4
   */
  function calculateLevel(correctCount) {
    if (correctCount >= 9) return 4;
    if (correctCount >= 6) return 3;
    if (correctCount >= 3) return 2;
    return 1;
  }

  /**
   * 정답률(%)에 따른 한국어 챔피언 등급
   * 0~39%: 도전자, 40~59%: 성장 중, 60~79%: 실버, 80~99%: 골드, 100%: 챔피언
   */
  function calculateGrade(accuracy) {
    if (accuracy >= 100) return '챔피언';
    if (accuracy >= 80) return '골드';
    if (accuracy >= 60) return '실버';
    if (accuracy >= 40) return '성장 중';
    return '도전자';
  }

  /**
   * 문제 응답 기록 및 채점
   * 규칙:
   * 1. 정답 시 기본 100점 + 콤보 + 1
   * 2. 2연속 정답부터 min(콤보, 5) * 20 보너스 점수 추가 지급
   * 3. 오답 시 콤보 0으로 초기화, 감점 없음
   */
  function submitAnswer(questionId, selectedIndex, originalAnswerIndex) {
    const isCorrect = (selectedIndex === originalAnswerIndex);
    let gainedScore = 0;
    let bonusScore = 0;

    if (isCorrect) {
      state.correctCount += 1;
      state.combo += 1;
      if (state.combo > state.maxCombo) {
        state.maxCombo = state.combo;
      }

      const baseScore = 100;
      if (state.combo >= 2) {
        bonusScore = Math.min(state.combo, 5) * 20;
      }
      gainedScore = baseScore + bonusScore;
      state.score += gainedScore;
    } else {
      state.combo = 0;
    }

    state.answers.push({
      questionId: questionId,
      selectedIndex: selectedIndex,
      isCorrect: isCorrect
    });

    return {
      isCorrect: isCorrect,
      selectedIndex: selectedIndex,
      correctIndex: originalAnswerIndex,
      gainedScore: gainedScore,
      bonusScore: bonusScore,
      currentCombo: state.combo,
      totalScore: state.score,
      currentLevel: calculateLevel(state.correctCount)
    };
  }

  /**
   * 제출 데이터 규격 (7장 규격 엄수, 필드 이름 및 타입 고정)
   */
  function buildSubmissionPayload() {
    const val = validateStudentInfo(state.classNumber, state.studentNumber);
    if (!val.isValid || state.classNumber === null || state.studentNumber === null) {
      return null;
    }

    const totalQuestions = (window.QUIZ_DATA && window.QUIZ_DATA.questions)
      ? window.QUIZ_DATA.questions.length
      : state.answers.length;

    const accuracy = totalQuestions > 0
      ? Math.round((state.correctCount / totalQuestions) * 100)
      : 0;

    const grade = calculateGrade(accuracy);

    return {
      quizTitle: (window.QUIZ_DATA && window.QUIZ_DATA.title) ? window.QUIZ_DATA.title : '퀴즈 챔피언',
      classNumber: Number(state.classNumber),
      studentNumber: Number(state.studentNumber),
      score: Number(state.score),
      correctCount: Number(state.correctCount),
      totalQuestions: Number(totalQuestions),
      accuracy: Number(accuracy),
      maxCombo: Number(state.maxCombo),
      grade: String(grade),
      answers: state.answers.map(function (item) {
        return {
          questionId: item.questionId,
          selectedIndex: Number(item.selectedIndex),
          isCorrect: Boolean(item.isCorrect)
        };
      })
    };
  }

  /**
   * 최종 결과 데이터 요약
   */
  function getResultSummary() {
    const totalQuestions = (window.QUIZ_DATA && window.QUIZ_DATA.questions)
      ? window.QUIZ_DATA.questions.length
      : state.answers.length;

    const accuracy = totalQuestions > 0
      ? Math.round((state.correctCount / totalQuestions) * 100)
      : 0;

    const grade = calculateGrade(accuracy);
    const level = calculateLevel(state.correctCount);

    return {
      classNumber: state.classNumber,
      studentNumber: state.studentNumber,
      studentLabel: (state.classNumber && state.studentNumber) ? `${state.classNumber}반 ${state.studentNumber}번` : '',
      score: state.score,
      correctCount: state.correctCount,
      totalQuestions: totalQuestions,
      accuracy: accuracy,
      maxCombo: state.maxCombo,
      level: level,
      grade: grade,
      answers: state.answers
    };
  }

  /**
   * 선택적 결과 전송 함수 (전송 규격 엄수)
   * @param {function} onStatusChange - 상태 변경 시 콜백 ('sending' | 'success' | 'error')
   */
  async function sendSubmissionIfConfigured(onStatusChange) {
    if (!SUBMISSION_ENDPOINT || typeof SUBMISSION_ENDPOINT !== 'string' || SUBMISSION_ENDPOINT.trim() === '') {
      return { skipped: true };
    }

    if (state.hasSubmitted) {
      return { skipped: true, alreadySubmitted: true };
    }

    const payload = buildSubmissionPayload();
    if (!payload) {
      if (typeof onStatusChange === 'function') {
        onStatusChange('error', '기록하지 못했어요. 선생님께 알려 주세요');
      }
      return { success: false, error: '유효한 반/번호가 아닙니다.' };
    }

    state.hasSubmitted = true;
    state.submissionStatus = 'sending';
    if (typeof onStatusChange === 'function') {
      onStatusChange('sending', '기록 중…');
    }

    try {
      const response = await fetch(SUBMISSION_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('서버 응답 오류: ' + response.status);
      }

      const result = await response.json();
      if (result && result.ok === true) {
        state.submissionStatus = 'success';
        if (typeof onStatusChange === 'function') {
          onStatusChange('success', '기록 완료');
        }
        return { success: true, result: result };
      } else {
        throw new Error('처리 결과 불일치');
      }
    } catch (err) {
      state.submissionStatus = 'error';
      if (typeof onStatusChange === 'function') {
        onStatusChange('error', '기록하지 못했어요. 선생님께 알려 주세요');
      }
      return { success: false, error: err.message };
    }
  }

  /**
   * 게임 완전 초기화 (공용 기기를 위한 반·번호 포함 초기화)
   */
  function resetAll() {
    state.classNumber = null;
    state.studentNumber = null;
    state.currentQuestionIndex = 0;
    state.score = 0;
    state.combo = 0;
    state.maxCombo = 0;
    state.correctCount = 0;
    state.answers = [];
    state.hasSubmitted = false;
    state.submissionStatus = 'idle';
  }

  // 전역 객체로 등록
  window.QUIZ_SUBMIT = {
    validateStudentInfo: validateStudentInfo,
    startSession: startSession,
    submitAnswer: submitAnswer,
    calculateLevel: calculateLevel,
    calculateGrade: calculateGrade,
    buildSubmissionPayload: buildSubmissionPayload,
    getResultSummary: getResultSummary,
    sendSubmissionIfConfigured: sendSubmissionIfConfigured,
    resetAll: resetAll,
    getState: function () {
      return Object.assign({}, state);
    },
    getEndpoint: function () {
      return SUBMISSION_ENDPOINT;
    }
  };
})();
