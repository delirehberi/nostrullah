import { Personality } from '../src/types';
import informative from './informative';
import humorous from './humorous';
import enthusiastic from './enthusiastic';
import sarcastic from './sarcastic';
import philosophical from './philosophical';

export const personalityTemplates: Record<Personality, string> = {
    informative,
    humorous,
    enthusiastic,
    sarcastic,
    philosophical,
};
